# Infrastructure

Terraform for the hosted backend (`docs/architecture/plan.md`). Region is `us-east-2`, because the account's organization denies these services in every other region. Terraform 1.17.1 and the `hashicorp/aws` provider 6.71.0 are the tested versions.

Nothing here has been planned or applied. Derek runs every command below, with `AWS_PROFILE=afterclass`.

## Which stack is for what

| Stack | Purpose | State |
| --- | --- | --- |
| `bootstrap/` | The S3 bucket that holds the state of the other stacks. Run once. | local file |
| `shared/` | What the beta and the production stack both use: the ECR repository and the GitHub OIDC provider. | `shared/terraform.tfstate` in the bucket |
| `beta/` | The beta now: one small EC2 server running the existing app (SQLite, one process) and Caddy. | `beta/terraform.tfstate` in the bucket |
| `main/` | The production stack for later: ECS Fargate, an Application Load Balancer and optional RDS PostgreSQL. | `main/terraform.tfstate` in the bucket |

`beta/` and `main/` read `shared/` through `terraform_remote_state`, so they never create or fight over the OIDC provider (one is allowed per account) or the repository. Apply `shared/` before either of them. `main/` was never applied before the ECR repository and the OIDC provider moved to `shared/`, so nothing needs to migrate. If it had been, run `terraform state rm` for the two ECR resources and the provider in `main/`, then `terraform import` them in `shared/`, before the first plan of either.

## What each stack creates

`bootstrap/`

- An S3 bucket `afterclass-tfstate-<account id>`. It is versioned, encrypted with SSE-S3, closed to public access, refuses plain HTTP, and expires old state versions after 90 days.

`shared/`

- An ECR repository `afterclass-api` with scan on push and immutable tags. Its lifecycle policy expires untagged images after a day and keeps the 20 newest others. Recovery does not depend on it: the beta server keeps its running image on its own data volume (see "How the beta behaves" below).
- The account's GitHub OIDC provider.

`beta/`

- A VPC `10.1.0.0/16` with one public subnet, an internet gateway and no NAT gateway.
- A security group that admits ports 80 and 443 from `ingress_cidrs` and has no SSH rule. Egress is HTTPS only.
- An Elastic IP on a separate network interface, so the address is on the instance before its first boot command and survives a replacement.
- A `t4g.small` Amazon Linux 2023 ARM instance. The AMI comes from the SSM public parameter, IMDSv2 is required and the root volume is encrypted gp3. There is no key pair. Session Manager is the way in.
- A separate encrypted gp3 data volume of 20 GB with `prevent_destroy`, attached at `/dev/sdf` and mounted at `/data` by its volume id. Nothing formats it at boot. A Data Lifecycle Manager policy snapshots it daily and keeps 7.
- An instance role with `AmazonSSMManagedInstanceCore`, ECR pull from the shared repository only, CloudWatch Logs write to its own log group (14 days), `ssm:GetParameter` on `/afterclass/beta/*` only, and `kms:Decrypt` on the `aws/ssm` key only through Systems Manager in `us-east-2`. The managed policy allows reading every parameter, and the `aws/ssm` key policy lets any principal in the account decrypt through Systems Manager, so the role also denies every `ssm:GetParameter*` outside `/afterclass/beta/*`.
- Cloud-init (`user_data`) installs Docker, mounts `/data` once it is formatted, and sets up two systemd units. `afterclass-app` runs the image from ECR, and `afterclass-caddy` runs the pinned Caddy image as the reverse proxy on ports 80 and 443. Both containers join one Docker bridge network, `afterclass`, and Caddy proxies to `afterclass-app:8080`. Neither uses host networking, so the instance metadata hop limit of 1 keeps both away from the instance role's credentials. Both drop every capability, Caddy keeps only `NET_BIND_SERVICE`, both set `no-new-privileges`, and Caddy's root file system is read-only. Caddy's certificates live on `/data/caddy`. The app keeps its database in `/data/db`. Its config folder is `/run/afterclass-app`, mounted read-only at `/data/config` and described in "Keys" below.
- A deploy role for `deploy-beta.yml`, a Systems Manager document that runs the deploy script with a commit hash, and an SSM parameter that holds the current instance id.
- With `domain` set, an A record for the apex in the existing Route 53 hosted zone.

`main/`

- A VPC with two public subnets in two zones, an internet gateway and no NAT gateway.
- Security groups. The load balancer admits port 80 from `alb_ingress_cidrs` only. The tasks admit the load balancer only. The database group admits the tasks only.
- An Application Load Balancer with a target group that checks `GET /health`. The idle timeout is 300 seconds, longer than the backend's 5-minute turn deadline. The target group waits 120 seconds before it drops a task, so a turn in progress can finish.
- An ECS cluster and one Fargate service on ARM, 0.25 vCPU and 0.5 GB, `desired_count` 1, with a deployment circuit breaker that rolls back. The execution role can pull from the shared repository and write to this log group. The task role has no permissions yet.
- A CloudWatch log group with 14 days of retention.
- A deploy role. Only a job in `DerekHertz/after-class` running in the `production` environment can assume it. The role can push to the shared repository, register a task definition, update this service and pass the two task roles.
- When `create_database = true`, an RDS PostgreSQL 17 instance on `db.t4g.micro`, single zone, 20 GB gp3, encrypted, not publicly accessible, deletion protection on, 7 days of backups, and a master password that RDS keeps in Secrets Manager.

## Beta variables

- `ingress_cidrs` is required and has no default. Use `["<your public IP>/32"]` until sign-in lands, then `["0.0.0.0/0"]`.
- `sslip_https` defaults to `false`. Set it to `true` with no domain to serve HTTPS on `<elastic-ip-with-dashes>.sslip.io`, a free public name that resolves to the Elastic IP, so the beta has a real certificate before a domain is bought. Like `domain`, it needs `ingress_cidrs` to include `0.0.0.0/0`.
- `domain` defaults to `null`: no DNS record, HTTP only on the Elastic IP. Set it to the apex domain, whose Route 53 hosted zone must exist, to turn on automatic HTTPS. Caddy gets its certificate from Let's Encrypt, which validates from the internet, so Terraform refuses a `domain` unless `ingress_cidrs` includes `0.0.0.0/0`. The exact apply is in "Turning on HTTPS" below.
- `availability_zone` defaults to `us-east-2a` and is pinned, so a change in the zone offerings never replaces the data volume. A precondition checks that the instance type is offered there.
- `caddy_image` is pinned by version and digest. To update it, read the new index digest from the registry and change both.
- `clerk_publishable_key` is required. It is the `pk_live_...` or `pk_test_...` key from Clerk's API keys page, and it is public. Terraform derives the issuer and the JWKS URL from it and sets the app's public origin from `public_url`. Keep it in `infra/beta/terraform.tfvars`.
- `extension_id` defaults to `null`, which lets no extension connect. Set it to the Chrome Web Store id once the listing exists.

## Commands, in order

Derek's first beta setup.

1. Create the state bucket. Skip it if `bootstrap/` already ran.

   ```
   cd infra/bootstrap
   terraform init
   terraform plan
   terraform apply
   ```

   Keep `infra/bootstrap/terraform.tfstate`. It is ignored by git. Losing it means importing the bucket by hand, and the bucket has `prevent_destroy`.

2. Create the shared stack. Use the `state_bucket` output from step 1.

   ```
   cd ../shared
   terraform init -backend-config="bucket=afterclass-tfstate-<account id>"
   terraform plan -out=shared.tfplan
   terraform apply shared.tfplan
   ```

3. Store the app's keys in Parameter Store, then create the beta server. Derek's two parameters are already in place, so on his account this is only for a rotation. The keys must exist before the plan, because the `aws/ssm` key that Terraform looks up appears with the account's first SecureString parameter. Each command reads the value from the terminal without echo and hands it to the CLI on stdin, so it stays out of the shell history and out of the process list that `ps` shows. A value must be one line of printable characters without spaces or quotes, or the app refuses to start.

   ```
   read -rs JEV_KEY && printf '%s' "$JEV_KEY" | aws ssm put-parameter --region us-east-2 --type SecureString \
     --overwrite --name /afterclass/beta/TYPESAFE_API_KEY --value file:///dev/stdin && unset JEV_KEY
   read -rs ANTHROPIC_KEY && printf '%s' "$ANTHROPIC_KEY" | aws ssm put-parameter --region us-east-2 --type SecureString \
     --overwrite --name /afterclass/beta/AFTERCLASS_ANTHROPIC_API_KEY --value file:///dev/stdin && unset ANTHROPIC_KEY
   ```

   ```
   cd ../beta
   terraform init -backend-config="bucket=afterclass-tfstate-<account id>"
   terraform plan -var='ingress_cidrs=["<your public IP>/32"]' -var='clerk_publishable_key=<pk_...>' -out=beta.tfplan
   terraform apply beta.tfplan
   ```

   The instance boots and installs Docker in a few minutes. Its bootstrap then stops at the mount and leaves the app and Caddy stopped, because the new data volume is blank and boot never formats. The failed `runcmd` in the cloud-init log is expected.

   Format the data volume once in its life, and finish the setup. Wait a few minutes after the apply, so the instance is registered with Systems Manager. The volume id is the confirmation, and the format refuses unless the volume reads as blank.

   ```
   aws ssm send-command --instance-ids <instance_id output> --document-name AWS-RunShellScript \
     --parameters 'commands=["/usr/local/sbin/afterclass-format-data <data_volume_id output> && /usr/local/sbin/afterclass-bootstrap"]' \
     --query Command.CommandId --output text
   aws ssm get-command-invocation --instance-id <instance_id output> --command-id <command id from above> \
     --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
   ```

   The status must be `Success` and the output must end with `afterclass-bootstrap: done`. Caddy then runs and answers 502, because no image has been deployed. A second run of the command refuses, because the volume is no longer blank. Never run it on a replacement instance or a restored volume, which already hold a filesystem.

4. In GitHub, create the `production` environment with Derek as the required reviewer and **Deployment branches** set to `master` only. The role trust cannot see the branch, so this setting is what keeps other branches out. It also means any job that runs in this environment can assume the beta role and the main role, so keep the setting. Add these environment variables from the outputs of `beta/` and `shared/`. They are not secrets.

   - `BETA_ROLE_ARN` from `deploy_role_arn`
   - `BETA_INSTANCE_PARAMETER` from `instance_id_parameter`
   - `BETA_DEPLOY_DOCUMENT` from `deploy_document_name`
   - `BETA_URL` from `public_url`
   - `ECR_REPOSITORY` from the `ecr_repository_name` output of `shared/`
   - `BETA_PUBLIC_CHECK` set to `false`, until `ingress_cidrs` includes `0.0.0.0/0`. A GitHub runner cannot reach the server while only Derek's address is allowed. The server's own check of `/health` still gates the deploy.

5. Cut a release and deploy it, as in "Releases" below. The app runs live, so the flow document's conditions for the first hosted live call apply: the spending limits are merged, Derek has set the amounts, and Derek approves the deploy. The deploy builds the arm64 image, pushes it to the shared repository by commit hash, and has the server pull it and restart the app. The server checks `/health` itself and rolls back to the previous image if the new one does not turn healthy. A healthy image is also saved on the server's data volume, and the workflow prints a warning if that save failed. From the allowed address, `curl <public_url>/health` returns `{"ok":true}`.

6. To open a shell, run `aws ssm start-session --target <instance_id output>`. This needs the Session Manager plugin for the AWS CLI on Derek's machine. The container logs are in the CloudWatch log group `/afterclass-beta`, in the streams `app` and `caddy`.

When sign-in lands and the domain exists, run `terraform apply` in `beta/` again with `ingress_cidrs=["0.0.0.0/0"]` and `domain=<apex domain>`, then delete the `BETA_PUBLIC_CHECK` variable and set `BETA_URL` again from the new `public_url`. The change replaces the instance, because the Caddyfile is part of `user_data`. The Elastic IP, the data volume and the certificates stay, and the new instance starts the last deployed image by itself.

## Keys

The app runs live, with Claude through the Messages API and Clerk sign-in, so it needs `TYPESAFE_API_KEY` and `AFTERCLASS_ANTHROPIC_API_KEY`. ElevenLabs stays off in the beta, so there is no key for it. The keys are SecureString parameters under `/afterclass/beta/`, encrypted with the default `aws/ssm` key. No key is in Terraform, its state, `user_data`, the image or the data volume.

At every start of the app unit, `afterclass-fetch-keys` reads both parameters and writes `keys.env`, mode 0600 and owned by the container's user, into `/run/afterclass-app`. systemd creates that folder on tmpfs at each start and removes it at each stop. The script refuses a folder that is not on tmpfs, prints no value even under `bash -x`, and fails the start when a parameter is missing, unreadable, or not one line of printable characters without spaces or quotes. The app container mounts the folder read-only at `/data/config`, where the image's `AFTERCLASS_CONFIG_DIR` points. The failure is a line that starts with `afterclass-fetch-keys:` in `journalctl -u afterclass-app`, and systemd tries again every 5 seconds.

To rotate a key, put the new value with the step 3 command and restart the app, through Session Manager: `systemctl restart afterclass-app`. A deploy restarts it too.

## Releases

A release is a `v<major>.<minor>.<patch>` tag on a commit on `master` whose `package.json` has the same version. The first is `v0.1.0`.

1. In a pull request, set `version` in `package.json` to the new version, and merge it.
2. Tag the merge commit and push the tag. The `release` workflow checks that the tag is on `master` and equals the package version, and creates a GitHub Release with generated notes.

   ```
   git switch master && git pull
   git tag -a v0.1.0 -m v0.1.0
   git push origin v0.1.0
   ```

3. Deploy the tag, then approve the run in the `production` environment.

   ```
   gh workflow run deploy-beta --ref master -f tag=v0.1.0
   ```

   The workflow runs from `master`, because the environment allows no other branch. With `master`'s own `scripts/check-release-tag.ts`, it refuses a tag whose commit is not on a freshly fetched `master` or whose `package.json` there has another version. Only then does it check out the tag's commit, and it deploys the image built from the tag's commit. The image tag on ECR and on the server is still that commit's hash. Redeploying an older tag is a rollback.

Only Derek may create, move or delete a `v*` tag. The ruleset is `infra/github/tag-ruleset.json`. It applies to every account except the repository admin role, which on this personal repository is Derek alone. Because Derek bypasses it, the rule against force pushes does not stop Derek himself, so never move a pushed release tag. Apply it once:

```
gh api --method POST repos/DerekHertz/after-class/rulesets --input infra/github/tag-ruleset.json
```

## Turning on HTTPS

Run these in `infra/beta` after the first setup. Each apply changes the Caddyfile, which is part of `user_data`, so it replaces the instance. The Elastic IP, the data volume and the certificates on it stay, the new instance starts the last deployed image by itself, and the beta is down for a few minutes. Keep the variables in `infra/beta/terraform.tfvars`, which git ignores, or repeat them on every later plan. A plan without them turns HTTPS off again.

For `useafterclass.com`, once the domain is registered and its public Route 53 hosted zone exists. A domain registered through Route 53 creates the zone. A domain registered elsewhere needs the zone created and its name servers set at the registrar first.

```
cd infra/beta
terraform plan -var='ingress_cidrs=["0.0.0.0/0"]' -var='domain=useafterclass.com' -out=beta.tfplan
terraform apply beta.tfplan
```

Terraform adds an A record for the apex that points at the Elastic IP, and Caddy asks Let's Encrypt for `useafterclass.com`. The `www` name is not served. `terraform output public_url` prints `https://useafterclass.com`. Set `BETA_URL` to it and delete `BETA_PUBLIC_CHECK`.

To get HTTPS before the domain exists, use `sslip_https`. It serves `https://<elastic-ip-with-dashes>.sslip.io`, for example `https://203-0-113-7.sslip.io`, with a real certificate. `domain` stays `null`, and `domain` wins when both are set.

```
cd infra/beta
terraform plan -var='ingress_cidrs=["0.0.0.0/0"]' -var='sslip_https=true' -out=beta.tfplan
terraform apply beta.tfplan
```

`terraform output public_url` prints the address. Set `BETA_URL` to it and delete `BETA_PUBLIC_CHECK`. Moving from sslip.io to the domain later is the first command above, and the sslip.io name stops being served.

Caddy passes the client's `Host` header to the app unchanged and adds `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`. It replaces any of those that a client sends, because no `trusted_proxies` is set. The app can check the public origin from these headers. Today the app still applies its localhost Host check, so a public name answers `/health` and nothing else until the hosted sign-in change replaces that check with the public origin.

## How the beta behaves on reboot, replacement and failure

- A reboot needs no script. `/etc/fstab` mounts `/data` by the volume's device name with `nofail`, and both units are enabled. The app unit refuses to start without the mount.
- Cloud-init runs `afterclass-bootstrap` once per instance. Every step reads the current state first, so running it again by hand through Session Manager changes nothing that is already right.
- Bootstrap never formats. It mounts the data volume by its `/dev/disk/by-id` name, which holds the volume id, and writes the same name to `/etc/fstab`. When the mount fails, bootstrap exits with an error that names `afterclass-format-data`, before it creates the Docker network or enables, starts or restarts either unit. Boot cannot tell a blank disk from a used one it fails to read. `blkid` and `wipefs` have reported a read error as "nothing found", and `wipefs` can print nothing and exit 0 when a read fails inside it.
- `afterclass-format-data <volume id>` is the only thing that formats, and only when Derek runs it. It refuses unless the argument equals this server's data volume id, no other format holds its `flock`, `/data` is not mounted, the first MiB reads back as zeros, `wipefs` exits 0 and lists no signature, and a read-only `mount` fails. A new EBS volume reads as zeros. A read error fails the zero check, which `wipefs` alone could miss. It runs `mkfs.xfs` without `-f`, so `mkfs.xfs` also refuses a disk that holds a filesystem. Bootstrap takes the same lock around its mount, so it never mounts a half-written filesystem.
- A change to the settings, the units, the scripts or the Caddyfile changes `user_data` and replaces the instance, with a few minutes of downtime. A new Amazon Linux release does not, because the AMI is ignored. Replace it on purpose with `terraform apply -replace=aws_instance.beta`.
- On replacement Terraform stops the old instance, detaches the data volume, creates the new instance, and attaches the volume again. The new instance's bootstrap waits up to 5 minutes for the device. The current image tag is stored on `/data`, so the app comes back by itself. So is the image: after every healthy deploy, and after every rollback, the server saves the running image with `docker save` to `/data/afterclass/images/<tag>.tar`. It writes under a temporary name and renames, so a crash leaves no half file. It keeps the running image and the one it replaced, and deletes every other tarball. The save never trusts a tarball that is already there. It saves the running image from Docker every time and renames the new file over the old one, so a damaged tarball is replaced by the next healthy deploy, and a failed save leaves the old file whole. When the image is not on the host, the save fails and deletes nothing. The app unit's pull step uses the tarball only when Docker no longer has the image, so a replacement instance starts the right image even after ECR has expired the tag. `docker load` is the only check of the tarball. A load that fails, or loads another image, prints an `ERROR` line and the image comes from ECR.
- A deploy that does not turn healthy within 90 seconds, or whose restart fails, is rolled back to the previous tag, and the workflow fails. A failed cleanup of old images after a healthy deploy is ignored.
- The image save never fails a healthy deploy. It refuses to run when less than the image size plus 2 GiB would stay free on `/data`, so the images cannot starve the database of space, and it removes its temporary file when a save fails. The server prints a `WARNING` line, and the workflow shows it as an annotation. Until the next deploy saves the image, a replaced instance needs ECR to still hold the tag, which the 20-image retention covers for any recent deploy.
- Room on the data volume. A local amd64 build of this image is 381 MB unpacked, and `docker save` writes about that much per image on the server's overlay2 store. Two kept images plus one being written is about 1.1 GB of the 20 GB. The ARM image was not measured.
- To restore a snapshot, create the volume from it by hand, then replace the resource in the state and apply. The apply replaces the instance, because the volume id is in `user_data`. The new instance mounts the restored volume. This procedure is written down and was not tested.

  ```
  aws ec2 create-volume --availability-zone us-east-2a --snapshot-id <snapshot id> --volume-type gp3 \
    --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=afterclass-beta-data},{Key=afterclass-snapshot,Value=daily}]'
  cd infra/beta
  terraform state rm aws_volume_attachment.data aws_ebs_volume.data
  terraform import aws_ebs_volume.data <new volume id>
  terraform plan -var='ingress_cidrs=["<your public IP>/32"]' -out=beta.tfplan
  ```

  Read the plan. It must replace `aws_instance.beta` and `aws_volume_attachment.data` and add only the default tags to the volume. Then apply it. If the snapshot was taken before the first format, it is blank, and bootstrap stops with the error that names `afterclass-format-data`. Do not format it. Pick a later snapshot.
- The snapshots are crash-consistent. SQLite recovers from that. A snapshot taken during a write is not a clean backup.

## Main stack variables

- `alb_ingress_cidrs` is required and has no default. Use `["<your public IP>/32"]`.
- `create_database` defaults to `false`. The app does not use Postgres yet, and the instance bills around the clock.
- `desired_count` defaults to `1`. Set `0` to stop paying for compute and keep everything else.
- `certificate_arn` defaults to `null`, which serves HTTP only. When a domain and an ACM certificate exist, set it and the load balancer adds a 443 listener and redirects port 80 to it.

Main stack commands, later. Apply `shared/` first, then:

```
cd infra/main
terraform init -backend-config="bucket=afterclass-tfstate-<account id>"
terraform plan -var='alb_ingress_cidrs=["<your public IP>/32"]' -out=main.tfplan
terraform apply main.tfplan
```

Add the `AWS_ROLE_ARN`, `ECS_CLUSTER` and `ECS_SERVICE` environment variables from its outputs, then run the `deploy` workflow. Terraform does not own the running task definition revision. The deploy workflow registers each revision, and the service ignores `task_definition` changes, so a later `terraform apply` does not roll a deploy back.

## Monthly cost estimate

730 hours a month, `us-east-2`. "Fetched" means the number was in the text of an AWS pricing page fetched on 2026-11-13. "Page example" means the page gave it in a worked example without naming the region. "Unverified" means the pricing table did not render or was not read, and the figure is from memory. The sums are my arithmetic.

| Beta resource | Estimate | Source |
| --- | --- | --- |
| `t4g.small` on demand, $0.0168 an hour | about $12.26 | unverified, the EC2 pricing table did not render |
| Elastic IP, $0.005 an hour whether in use or idle | $3.65 | fetched, VPC pricing page |
| Root volume, 12 GB gp3, and data volume, 20 GB gp3, at $0.08 per GB-month | about $2.56 | page example, EBS pricing page. The first 3,000 IOPS and 125 MB/s are included (fetched) |
| Daily snapshots, 7 kept, at $0.05 per GB-month | under $1 for a mostly empty volume, at most $7 if every snapshot held 20 GB | page example, EBS pricing page. Snapshots are incremental, so the real figure is near the low end |
| CloudWatch Logs, $0.50 per GB ingested | $0 to $1 | page example. The free tier of 5 GB a month is fetched. The log volume is a guess |
| ECR storage, about 2 GB of images | about $0.20 | unverified |
| Route 53 hosted zone, only with a domain | about $0.50 | unverified |
| Domain registration | a yearly charge, not monthly | not read |
| Beta total, low-change case | about $19 to $22 a month | sum of the rows above, with snapshots near $1, no logs and no domain |
| Beta total, upper case | about $27 a month | the same rows with snapshots at $7, logs at $1 and Route 53 at $0.50 |

For comparison, the `main/` skeleton without the database is about $35 a month, with the figures in `docs/architecture/decision.md`. Data transfer out and the AWS free plan or credits were not checked.

## Path to production

The beta is the existing app on one server, so what moves to `main/` is small.

- The same image moves. `shared/` already owns the ECR repository, so the ECS service pulls the images the beta deploys use. The same OIDC provider and the same `production` environment gate both deploy workflows.
- The data moves from SQLite to PostgreSQL. The one-off importer in Phase 3 of `docs/architecture/plan.md` reads `afterclass.sqlite` and the `frames/` folder from `/data/db` on the beta server and writes the RDS database that `main/` creates with `create_database = true`, plus the frame bucket. Neither the importer nor the Postgres code path exists yet.
- The server's job changes. Caddy and the single host give way to the load balancer and Fargate tasks. Running more than one task needs the asynchronous storage of Phase 2, the frame store of Phase 3 and the separate API and worker processes of Phase 6. Until then the beta stays one process.
- When production is live, run `terraform destroy` in `beta/`. `prevent_destroy` on the data volume stops it, which is intended. Take a snapshot, confirm the import, then remove that guard by hand and destroy.
