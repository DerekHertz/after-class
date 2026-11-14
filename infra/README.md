# Infrastructure

Terraform for the hosted backend (`docs/architecture/plan.md`). Region is `us-east-2`, because the account's organization denies these services in every other region. Terraform 1.17.1 and the `hashicorp/aws` provider 6.71.0 are the tested versions.

Derek runs every command below, with `AWS_PROFILE=afterclass`. `bootstrap/` is applied, and so are the ECR repository and its lifecycle policy in `shared/`. Nothing in `beta/` or `main/` exists yet.

This AWS account is a member account that AWS manages through its account and project feature. A service control policy that Derek cannot see or edit denies IAM OIDC providers, even `iam:ListOpenIDConnectProviders`. GitHub Actions therefore cannot assume an AWS role. The release workflow builds the image and pushes it to GHCR with `GITHUB_TOKEN`, and Derek deploys from his own machine with `scripts/deploy-beta.sh`. No AWS credential is stored in GitHub, and no workflow signs in to AWS.

## Which stack is for what

| Stack | Purpose | State |
| --- | --- | --- |
| `bootstrap/` | The S3 bucket that holds the state of the other stacks. Run once. | local file |
| `shared/` | The ECR repository of the parked production stack. The beta does not use it. | `shared/terraform.tfstate` in the bucket |
| `beta/` | The beta now: one small EC2 server running the existing app (SQLite, one process) and Caddy. | `beta/terraform.tfstate` in the bucket |
| `main/` | The production stack for later: ECS Fargate, an Application Load Balancer and optional RDS PostgreSQL. | `main/terraform.tfstate` in the bucket |

`main/` reads `shared/` through `terraform_remote_state`, so apply `shared/` before it. `beta/` reads nothing from `shared/`. Its image is `ghcr.io/derekhertz/after-class`, written into the server scripts.

## What each stack creates

`bootstrap/`

- An S3 bucket `afterclass-tfstate-<account id>`. It is versioned, encrypted with SSE-S3, closed to public access, refuses plain HTTP, and expires old state versions after 90 days.

`shared/`

- An ECR repository `afterclass-api` with scan on push and immutable tags, for `main/`. Its lifecycle policy expires untagged images after a day and keeps the 20 newest others.

`beta/`

- A VPC `10.1.0.0/16` with one public subnet, an internet gateway and no NAT gateway.
- A security group that admits ports 80 and 443 from `ingress_cidrs` and has no SSH rule. Egress is HTTPS only.
- An Elastic IP on a separate network interface, so the address is on the instance before its first boot command and survives a replacement.
- A `t4g.small` Amazon Linux 2023 ARM instance. The AMI comes from the SSM public parameter, IMDSv2 is required and the root volume is encrypted gp3. There is no key pair. Session Manager is the way in.
- A separate encrypted gp3 data volume of 20 GB with `prevent_destroy`, attached at `/dev/sdf` and mounted at `/data` by its volume id. Nothing formats it at boot. A Data Lifecycle Manager policy snapshots it daily and keeps 7.
- An instance role with `AmazonSSMManagedInstanceCore`, CloudWatch Logs write to its own log group (14 days), `ssm:GetParameter` on `/afterclass/beta/*` only, and `kms:Decrypt` on the `aws/ssm` key only through Systems Manager in `us-east-2`. The managed policy allows reading every parameter, and the `aws/ssm` key policy lets any principal in the account decrypt through Systems Manager, so the role also denies every `ssm:GetParameter*` outside `/afterclass/beta/*`.
- Cloud-init (`user_data`) installs Docker, mounts `/data` once it is formatted, and sets up two systemd units. `afterclass-app` runs the app image from GHCR, pulled by digest without a sign-in, and `afterclass-caddy` runs the pinned Caddy image as the reverse proxy on ports 80 and 443. Both containers join one Docker bridge network, `afterclass`, and Caddy proxies to `afterclass-app:8080`. Neither uses host networking, so the instance metadata hop limit of 1 keeps both away from the instance role's credentials. Both drop every capability, Caddy keeps only `NET_BIND_SERVICE`, both set `no-new-privileges`, and Caddy's root file system is read-only. Caddy's certificates live on `/data/caddy`. The app keeps its database in `/data/db`. Its config folder is `/run/afterclass-app`, mounted read-only at `/data/config` and described in "Keys" below.
- A Systems Manager document that runs the deploy script with a commit hash and an image digest, and an SSM parameter that holds the current instance id. `scripts/deploy-beta.sh` uses both.
- With `domain` set, an A record for the apex in the existing Route 53 hosted zone.

`main/`

- A VPC with two public subnets in two zones, an internet gateway and no NAT gateway.
- Security groups. The load balancer admits port 80 from `alb_ingress_cidrs` only. The tasks admit the load balancer only. The database group admits the tasks only.
- An Application Load Balancer with a target group that checks `GET /health`. The idle timeout is 300 seconds, longer than the backend's 5-minute turn deadline. The target group waits 120 seconds before it drops a task, so a turn in progress can finish.
- An ECS cluster and one Fargate service on ARM, 0.25 vCPU and 0.5 GB, `desired_count` 1, with a deployment circuit breaker that rolls back. The execution role can pull from the shared repository and write to this log group. The task role has no permissions yet.
- A CloudWatch log group with 14 days of retention.
- A deploy role. Only a job in `DerekHertz/after-class` running in the `production` environment can assume it. It trusts the OIDC provider given as `github_oidc_provider_arn`, which this account cannot create, so `main/` cannot be applied here as it stands. The role can push to the shared repository, register a task definition, update this service and pass the two task roles.
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

2. Skip `shared/` for the beta. Derek's apply already created the ECR repository, and the failed OIDC provider is gone from the code, so a plan in `shared/` shows no changes. Only `main/` needs it.

3. Store the app's keys in Parameter Store, then create the beta server. Derek's two parameters are already in place, so on his account this is only for a rotation. The keys must exist before the plan, because the `aws/ssm` key that Terraform looks up appears with the account's first SecureString parameter. Each command reads the value from the terminal without echo and hands it to the CLI on stdin, so it stays out of the shell history and out of the process list that `ps` shows. A value must be one line of printable characters without spaces or quotes, or the app refuses to start.

   ```
   read -rs JEV_KEY && printf '%s' "$JEV_KEY" | aws ssm put-parameter --region us-east-2 --type SecureString \
     --overwrite --name /afterclass/beta/TYPESAFE_API_KEY --value file:///dev/stdin && unset JEV_KEY
   read -rs ANTHROPIC_KEY && printf '%s' "$ANTHROPIC_KEY" | aws ssm put-parameter --region us-east-2 --type SecureString \
     --overwrite --name /afterclass/beta/AFTERCLASS_ANTHROPIC_API_KEY --value file:///dev/stdin && unset ANTHROPIC_KEY
   ```

   ```
   cd infra/beta
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

4. Cut the first release, as in "Releases" below, starting with its first step, the publishing restrictions. The `release` workflow pushes `ghcr.io/derekhertz/after-class:<commit>` and `:v0.1.0` and records the image's digest in the GitHub Release. GHCR creates the package as private, and the server pulls without a sign-in, so make it public once.

   On GitHub, open the profile's **Packages** tab, then `after-class`, then **Package settings**. Under **Danger Zone**, choose **Change visibility**, then **Public**, and type the package name to confirm. The image holds no keys. They reach the server from Parameter Store at each start.

5. Deploy the release from Derek's machine, at the root of his clone of the repository. The app runs live, so the flow document's conditions for the first hosted live call apply: the spending limits are merged, Derek has set the amounts, and Derek approves the deploy. Running the script is that approval.

   ```
   aws login
   scripts/deploy-beta.sh v0.1.0
   ```

   The script needs `git`, `bun`, `gh`, `curl` and the AWS CLI. It refuses a tag that is not on `master` or does not match `package.json`, a release without a well-formed `image-digest.txt` for the tag's commit, and a digest GHCR does not serve anonymously. It then sends the deploy document and waits up to 15 minutes for the result. The server pulls the image by that digest, restarts the app, checks `/health` itself and rolls back to the previous image if the new one does not turn healthy. A healthy image is also saved on the server's data volume, and the server's output, which the script prints, has a `WARNING` line if that save failed. From the allowed address, `curl <public_url>/health` returns `{"ok":true}`.

6. To open a shell, run `aws ssm start-session --target <instance_id output>`. This needs the Session Manager plugin for the AWS CLI on Derek's machine. The container logs are in the CloudWatch log group `/afterclass-beta`, in the streams `app` and `caddy`.

When sign-in lands and the domain exists, run `terraform apply` in `beta/` again with `ingress_cidrs=["0.0.0.0/0"]` and `domain=<apex domain>`. The change replaces the instance, because the Caddyfile is part of `user_data`. The Elastic IP, the data volume and the certificates stay, and the new instance starts the last deployed image by itself.

## Keys

The app runs live, with Claude through the Messages API and Clerk sign-in, so it needs `TYPESAFE_API_KEY` and `AFTERCLASS_ANTHROPIC_API_KEY`. ElevenLabs stays off in the beta, so there is no key for it. The keys are SecureString parameters under `/afterclass/beta/`, encrypted with the default `aws/ssm` key. No key is in Terraform, its state, `user_data`, the image or the data volume.

At every start of the app unit, `afterclass-fetch-keys` reads both parameters and writes `keys.env`, mode 0600 and owned by the container's user, into `/run/afterclass-app`. systemd creates that folder on tmpfs at each start and removes it at each stop. The script refuses a folder that is not on tmpfs, prints no value even under `bash -x`, and fails the start when a parameter is missing, unreadable, or not one line of printable characters without spaces or quotes. The app container mounts the folder read-only at `/data/config`, where the image's `AFTERCLASS_CONFIG_DIR` points. The failure is a line that starts with `afterclass-fetch-keys:` in `journalctl -u afterclass-app`, and systemd tries again every 5 seconds.

To rotate a key, put the new value with the step 3 command and restart the app, through Session Manager: `systemctl restart afterclass-app`. A deploy restarts it too.

## Releases

A release is a `v<major>.<minor>.<patch>` tag on a commit on `master` whose `package.json` has the same version. The first is `v0.1.0`. The deployed image is named by the digest that the release workflow records in the tag's GitHub Release, never by a GHCR tag. GHCR tags are mutable: anyone who can write the package can point `:<commit>` at other bytes.

1. Before the first release, restrict who can publish. Do all three once, in this order.

   - Apply the tag ruleset, so only Derek can create, move or delete a `v*` tag. The ruleset is `infra/github/tag-ruleset.json`. It applies to every account except the repository admin role, which on this personal repository is Derek alone. A tag push runs `release.yml` as the tag has it, so without the ruleset a repository writer could push a `v*` tag on a branch with a changed workflow.

     ```
     gh api --method POST repos/DerekHertz/after-class/rulesets --input infra/github/tag-ruleset.json
     ```

   - On GitHub, open the profile's **Packages** tab, then `after-class`, then **Package settings**. Under **Manage Actions access**, keep `DerekHertz/after-class` as the only repository, with the **Write** role, and remove any other. Under **Manage access**, give no other account or repository write access. The package exists only after the first image push, so check this again right after the first release and before its deploy.
   - Only `release.yml` may request `packages: write`, and only in its `image` job. `test/release-workflow.test.ts` fails when any other workflow or job asks for it, or when a workflow leaves its token's permissions to the repository default.

   What this leaves open. Derek's own GitHub account can do everything above, so a compromise of that account, or of a token with its rights, can publish a release and its digest. A repository writer can still push an image to the package from a branch workflow that asks for `packages: write`. That moves tags, but no deploy reads a tag, and the test above only catches such a workflow in a pull request that runs the tests. A repository writer, or any workflow or app whose token has `contents: write`, can also replace a release's `image-digest.txt` and so choose which existing image the next deploy runs, and the tag ruleset does not stop that. So every repository writer and every workflow with `contents: write` is trusted. Today Derek is the only collaborator, and `claude.yml`, the one other workflow with `contents: write`, runs only for him. GitHub Actions itself, and the actions the workflows pin, are trusted.

2. In a pull request, set `version` in `package.json` to the new version, and merge it.
3. Tag the merge commit and push the tag. The `release` workflow runs three jobs in order. `check` refuses a tag that is not on `master` or does not equal the package version. `image` builds that commit for `linux/arm64`, pushes it as `ghcr.io/derekhertz/after-class:<commit>`, takes the digest from that push's own output, tags `:<tag>` from that digest, and fails unless both tags now resolve to it. It signs in to GHCR with `GITHUB_TOKEN` and holds only `contents: read` and `packages: write`. It never reuses an image that is already there, and any registry error fails the run. `release` then writes the GitHub Release, with generated notes, and attaches `image-digest.txt`, which reads `commit <commit>` and `digest sha256:<64 hex>`. The release is written last, so it never names an image that was not pushed and checked. A rerun builds again, pushes a new digest and replaces `image-digest.txt`.

   ```
   git switch master && git pull
   git tag -a v0.1.0 -m v0.1.0
   git push origin v0.1.0
   ```

4. When the `release` run is green, deploy the tag from the root of a clone of the repository.

   ```
   aws login
   scripts/deploy-beta.sh v0.1.0
   ```

   The script runs `scripts/check-release-tag.ts`, which fetches `master` and the tag afresh and refuses a tag whose commit is not on `master` or whose `package.json` there has another version. It reads `image-digest.txt` from the tag's release with `gh`, and refuses a release without one, a malformed digest, or a commit other than the tag's. It checks that GHCR serves that digest without a sign-in, finds the instance through `/afterclass-beta/instance_id`, and starts the `afterclass-beta-deploy` document with the commit and the digest. The document accepts only a 40-hex commit and a `sha256:` digest. The server pulls by digest, runs the image by the ID Docker reports for it, and records the digest as the running image. Redeploying an older tag is a rollback.

Because Derek bypasses the ruleset, the rule against force pushes does not stop Derek himself, so never move a pushed release tag.

## Turning on HTTPS

Run these in `infra/beta` after the first setup. Each apply changes the Caddyfile, which is part of `user_data`, so it replaces the instance. The Elastic IP, the data volume and the certificates on it stay, the new instance starts the last deployed image by itself, and the beta is down for a few minutes. Keep the variables in `infra/beta/terraform.tfvars`, which git ignores, or repeat them on every later plan. A plan without them turns HTTPS off again.

For `useafterclass.com`, once the domain is registered and its public Route 53 hosted zone exists. A domain registered through Route 53 creates the zone. A domain registered elsewhere needs the zone created and its name servers set at the registrar first.

```
cd infra/beta
terraform plan -var='ingress_cidrs=["0.0.0.0/0"]' -var='domain=useafterclass.com' -out=beta.tfplan
terraform apply beta.tfplan
```

Terraform adds an A record for the apex that points at the Elastic IP, and Caddy asks Let's Encrypt for `useafterclass.com`. The `www` name is not served. `terraform output public_url` prints `https://useafterclass.com`.

To get HTTPS before the domain exists, use `sslip_https`. It serves `https://<elastic-ip-with-dashes>.sslip.io`, for example `https://203-0-113-7.sslip.io`, with a real certificate. `domain` stays `null`, and `domain` wins when both are set.

```
cd infra/beta
terraform plan -var='ingress_cidrs=["0.0.0.0/0"]' -var='sslip_https=true' -out=beta.tfplan
terraform apply beta.tfplan
```

`terraform output public_url` prints the address. Moving from sslip.io to the domain later is the first command above, and the sslip.io name stops being served.

Caddy passes the client's `Host` header to the app unchanged and adds `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`. It replaces any of those that a client sends, because no `trusted_proxies` is set. The app can check the public origin from these headers. Today the app still applies its localhost Host check, so a public name answers `/health` and nothing else until the hosted sign-in change replaces that check with the public origin.

## How the beta behaves on reboot, replacement and failure

- A reboot needs no script. `/etc/fstab` mounts `/data` by the volume's device name with `nofail`, and both units are enabled. The app unit refuses to start without the mount.
- Cloud-init runs `afterclass-bootstrap` once per instance. Every step reads the current state first, so running it again by hand through Session Manager changes nothing that is already right.
- Bootstrap never formats. It mounts the data volume by its `/dev/disk/by-id` name, which holds the volume id, and writes the same name to `/etc/fstab`. When the mount fails, bootstrap exits with an error that names `afterclass-format-data`, before it creates the Docker network or enables, starts or restarts either unit. Boot cannot tell a blank disk from a used one it fails to read. `blkid` and `wipefs` have reported a read error as "nothing found", and `wipefs` can print nothing and exit 0 when a read fails inside it.
- `afterclass-format-data <volume id>` is the only thing that formats, and only when Derek runs it. It refuses unless the argument equals this server's data volume id, no other format holds its `flock`, `/data` is not mounted, the first MiB reads back as zeros, `wipefs` exits 0 and lists no signature, and a read-only `mount` fails. A new EBS volume reads as zeros. A read error fails the zero check, which `wipefs` alone could miss. It runs `mkfs.xfs` without `-f`, so `mkfs.xfs` also refuses a disk that holds a filesystem. Bootstrap takes the same lock around its mount, so it never mounts a half-written filesystem.
- A change to the settings, the units, the scripts or the Caddyfile changes `user_data` and replaces the instance, with a few minutes of downtime. A new Amazon Linux release does not, because the AMI is ignored. Replace it on purpose with `terraform apply -replace=aws_instance.beta`.
- On replacement Terraform stops the old instance, detaches the data volume, creates the new instance, and attaches the volume again. The new instance's bootstrap waits up to 5 minutes for the device. The running image's digest is stored on `/data/afterclass/current-image`, so the app comes back by itself. So is the image: after every healthy deploy, and after every rollback, the server saves the running image with `docker save` to `/data/afterclass/images/<digest hex>.tar`. It writes under a temporary name and renames, so a crash leaves no half file. It keeps the running image and the one it replaced, and deletes every other tarball. The save never trusts a tarball that is already there. It saves the running image from Docker every time and renames the new file over the old one, so a damaged tarball is replaced by the next healthy deploy, and a failed save leaves the old file whole. When the image is not on the host, the save fails and deletes nothing. The app unit's pull step uses the tarball only when Docker no longer has the image, so a replacement instance starts the right image even when GHCR no longer holds it. `docker save` and `docker load` keep an image's ID but drop its registry digest, on both the classic and the containerd image store (checked with Docker 25 and 29). So after each pull by digest, the server writes the ID Docker reports to `/data/afterclass/images/<digest hex>.id`, saves the image by that ID, and uses a tarball only when its load yields that ID. A load that fails, or loads another image, prints an `ERROR` line and the image comes from GHCR by digest. A tarball without an ID record is not used.
- A deploy that does not turn healthy within 90 seconds, or whose restart fails, is rolled back to the previous digest, and `scripts/deploy-beta.sh` fails. A failed cleanup of old images after a healthy deploy is ignored.
- The image save never fails a healthy deploy. It refuses to run when less than the image size plus 2 GiB would stay free on `/data`, so the images cannot starve the database of space, and it removes its temporary file when a save fails. The server prints a `WARNING` line, which `scripts/deploy-beta.sh` shows. Until the next deploy saves the image, a replaced instance needs GHCR to still hold it. Nothing deletes GHCR versions automatically.
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

Main stack commands, later. `github_oidc_provider_arn` is required and has no default. This account cannot create the provider, so the plan below needs an account that allows it, or `main/` needs another deploy route first. Apply `shared/` first, then:

```
cd infra/main
terraform init -backend-config="bucket=afterclass-tfstate-<account id>"
terraform plan -var='alb_ingress_cidrs=["<your public IP>/32"]' -var='github_oidc_provider_arn=<arn>' -out=main.tfplan
terraform apply main.tfplan
```

### Parked main stack, GitHub setup

`deploy.yml` deploys `main/` and runs in the `production` environment, which the deploy role's trust policy names (`infra/main/github.tf`). Before its first run:

1. In GitHub, create the `production` environment with Derek as the required reviewer and **Deployment branches** set to `master` only. The role trust cannot see the branch, so this setting is what keeps other branches out.
2. Add these environment variables to it. They are not secrets.

   - `AWS_ROLE_ARN` from the `deploy_role_arn` output of `main/`
   - `ECR_REPOSITORY` from the `ecr_repository_name` output of `shared/`
   - `ECS_CLUSTER` from the `ecs_cluster_name` output of `main/`
   - `ECS_SERVICE` from the `ecs_service_name` output of `main/`

Then run the `deploy` workflow. Terraform does not own the running task definition revision. The deploy workflow registers each revision, and the service ignores `task_definition` changes, so a later `terraform apply` does not roll a deploy back.

## Monthly cost estimate

730 hours a month, `us-east-2`. "Fetched" means the number was in the text of an AWS pricing page fetched on 2026-11-13. "Page example" means the page gave it in a worked example without naming the region. "Unverified" means the pricing table did not render or was not read, and the figure is from memory. The sums are my arithmetic.

| Beta resource | Estimate | Source |
| --- | --- | --- |
| `t4g.small` on demand, $0.0168 an hour | about $12.26 | unverified, the EC2 pricing table did not render |
| Elastic IP, $0.005 an hour whether in use or idle | $3.65 | fetched, VPC pricing page |
| Root volume, 12 GB gp3, and data volume, 20 GB gp3, at $0.08 per GB-month | about $2.56 | page example, EBS pricing page. The first 3,000 IOPS and 125 MB/s are included (fetched) |
| Daily snapshots, 7 kept, at $0.05 per GB-month | under $1 for a mostly empty volume, at most $7 if every snapshot held 20 GB | page example, EBS pricing page. Snapshots are incremental, so the real figure is near the low end |
| CloudWatch Logs, $0.50 per GB ingested | $0 to $1 | page example. The free tier of 5 GB a month is fetched. The log volume is a guess |
| ECR storage | $0, the repository is empty until `main/` deploys | unverified |
| GHCR storage and pulls of the public package | $0 | unverified |
| Route 53 hosted zone, only with a domain | about $0.50 | unverified |
| Domain registration | a yearly charge, not monthly | not read |
| Beta total, low-change case | about $19 to $22 a month | sum of the rows above, with snapshots near $1, no logs and no domain |
| Beta total, upper case | about $27 a month | the same rows with snapshots at $7, logs at $1 and Route 53 at $0.50 |

For comparison, the `main/` skeleton without the database is about $35 a month, with the figures in `docs/architecture/decision.md`. Data transfer out and the AWS free plan or credits were not checked.

## Path to production

The beta is the existing app on one server, so what moves to `main/` is small.

- The image moves, but not by itself. The beta's images are on GHCR, while `main/` still expects ECR and a GitHub OIDC deploy role. This account's service control policy denies the OIDC provider, so `main/` needs another deploy route, or another account, before it can be applied.
- The data moves from SQLite to PostgreSQL. The one-off importer in Phase 3 of `docs/architecture/plan.md` reads `afterclass.sqlite` and the `frames/` folder from `/data/db` on the beta server and writes the RDS database that `main/` creates with `create_database = true`, plus the frame bucket. Neither the importer nor the Postgres code path exists yet.
- The server's job changes. Caddy and the single host give way to the load balancer and Fargate tasks. Running more than one task needs the asynchronous storage of Phase 2, the frame store of Phase 3 and the separate API and worker processes of Phase 6. Until then the beta stays one process.
- When production is live, run `terraform destroy` in `beta/`. `prevent_destroy` on the data volume stops it, which is intended. Take a snapshot, confirm the import, then remove that guard by hand and destroy.
