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

- An ECR repository `afterclass-api` with scan on push and immutable tags. Its lifecycle policy expires untagged images after a day, keeps the 3 newest `live-<commit>` images whatever else is pushed, and keeps the 10 newest other images. The deploy workflow adds the `live-` tag to an image after the server reports it healthy, so the running image and the one it replaced cannot expire, even after many failed deploys. Immutable tags forbid re-tagging, but a second tag on the same image is a new name.
- The account's GitHub OIDC provider.

`beta/`

- A VPC `10.1.0.0/16` with one public subnet, an internet gateway and no NAT gateway.
- A security group that admits ports 80 and 443 from `ingress_cidrs` and has no SSH rule. Egress is HTTPS only.
- An Elastic IP on a separate network interface, so the address is on the instance before its first boot command and survives a replacement.
- A `t4g.small` Amazon Linux 2023 ARM instance. The AMI comes from the SSM public parameter, IMDSv2 is required and the root volume is encrypted gp3. There is no key pair. Session Manager is the way in.
- A separate encrypted gp3 data volume of 20 GB with `prevent_destroy`, attached at `/dev/sdf` and mounted at `/data`. A Data Lifecycle Manager policy snapshots it daily and keeps 7.
- An instance role with `AmazonSSMManagedInstanceCore`, ECR pull from the shared repository only, and CloudWatch Logs write to its own log group (14 days).
- Cloud-init (`user_data`) installs Docker, mounts `/data`, and sets up two systemd units. `afterclass-app` runs the image from ECR, and `afterclass-caddy` runs the pinned Caddy image as the reverse proxy on ports 80 and 443. Both containers join one Docker bridge network, `afterclass`, and Caddy proxies to `afterclass-app:8080`. Neither uses host networking, so the instance metadata hop limit of 1 keeps both away from the instance role's credentials. Both drop every capability, Caddy keeps only `NET_BIND_SERVICE`, both set `no-new-privileges`, and Caddy's root file system is read-only. Caddy's certificates live on `/data/caddy`. The app keeps its database in `/data/db` and its config folder in `/data/config`.
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

3. Create the beta server.

   ```
   cd ../beta
   terraform init -backend-config="bucket=afterclass-tfstate-<account id>"
   terraform plan -var='ingress_cidrs=["<your public IP>/32"]' -out=beta.tfplan
   terraform apply beta.tfplan
   ```

   The instance boots and sets itself up in a few minutes. The app does not run yet, because no image has been deployed. Caddy runs and answers 502.

4. In GitHub, create the `production` environment with Derek as the required reviewer and **Deployment branches** set to `master` only. The role trust cannot see the branch, so this setting is what keeps other branches out. It also means any job that runs in this environment can assume the beta role and the main role, so keep the setting. Add these environment variables from the outputs of `beta/` and `shared/`. They are not secrets.

   - `BETA_ROLE_ARN` from `deploy_role_arn`
   - `BETA_INSTANCE_PARAMETER` from `instance_id_parameter`
   - `BETA_DEPLOY_DOCUMENT` from `deploy_document_name`
   - `BETA_URL` from `public_url`
   - `ECR_REPOSITORY` from the `ecr_repository_name` output of `shared/`
   - `BETA_PUBLIC_CHECK` set to `false`, until `ingress_cidrs` includes `0.0.0.0/0`. A GitHub runner cannot reach the server while only Derek's address is allowed. The server's own check of `/health` still gates the deploy.

5. Run the `deploy-beta` workflow from `master` and approve it. It builds the arm64 image, pushes it to the shared repository by commit hash, and has the server pull it and restart the app. The server checks `/health` itself and rolls back to the previous image if the new one does not turn healthy. A healthy image then gets its `live-<commit>` tag. From the allowed address, `curl <public_url>/health` returns `{"ok":true}`.

6. To open a shell, run `aws ssm start-session --target <instance_id output>`. This needs the Session Manager plugin for the AWS CLI on Derek's machine. The container logs are in the CloudWatch log group `/afterclass-beta`, in the streams `app` and `caddy`.

When sign-in lands and the domain exists, run `terraform apply` in `beta/` again with `ingress_cidrs=["0.0.0.0/0"]` and `domain=<apex domain>`, then delete the `BETA_PUBLIC_CHECK` variable and set `BETA_URL` again from the new `public_url`. The change replaces the instance, because the Caddyfile is part of `user_data`. The Elastic IP, the data volume and the certificates stay, and the new instance starts the last deployed image by itself.

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

- A reboot needs no script. `/etc/fstab` mounts `/data` by label with `nofail`, and both units are enabled. The app unit refuses to start without the mount.
- Cloud-init runs `afterclass-bootstrap` once per instance. Every step reads the current state first, so running it again by hand through Session Manager changes nothing that is already right. It formats the data volume only when `blkid` reports no signature at all (exit status 2). It refuses a device that holds anything but xfs, and it refuses to format when `blkid` itself fails.
- A change to the settings, the units, the scripts or the Caddyfile changes `user_data` and replaces the instance, with a few minutes of downtime. A new Amazon Linux release does not, because the AMI is ignored. Replace it on purpose with `terraform apply -replace=aws_instance.beta`.
- On replacement Terraform stops the old instance, detaches the data volume, creates the new instance, and attaches the volume again. The new instance's bootstrap waits up to 5 minutes for the device. The current image tag is stored on `/data`, so the app comes back by itself.
- A deploy that does not turn healthy within 90 seconds, or whose restart fails, is rolled back to the previous tag, and the workflow fails. A failed cleanup of old images after a healthy deploy is ignored.
- To restore a snapshot, create an encrypted gp3 volume from it in the same zone. Then run `terraform state rm aws_volume_attachment.data aws_ebs_volume.data` and `terraform import aws_ebs_volume.data <new volume id>`, and apply. The apply replaces the instance, because the volume id is in `user_data`. The new instance mounts the restored volume. This procedure is written down and was not tested.
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
