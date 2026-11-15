# Infrastructure

Terraform for the hosted backend, planned in `docs/architecture/plan.md`. The region is `us-east-2`, because the account's organization denies these services in every other region. The tested versions are Terraform 1.17.1 and the `hashicorp/aws` provider 6.71.0.

Run every command with `AWS_PROFILE=afterclass`. `bootstrap/` and the ECR repository in `shared/` are applied. Nothing in `beta/` or `main/` exists yet.

A service control policy on this AWS account denies IAM OIDC providers, so GitHub Actions cannot assume an AWS role. The release workflow pushes the image to GHCR with `GITHUB_TOKEN`, and you deploy from your own machine with `scripts/deploy-beta.sh`. GitHub holds no AWS credential.

## Stacks

| Stack | Purpose | State |
| --- | --- | --- |
| `bootstrap/` | The versioned, encrypted S3 bucket `afterclass-tfstate-<account id>` for the other stacks' state. Run once. | local file |
| `shared/` | The ECR repository `afterclass-api` for `main/`. The beta does not use it. | `shared/terraform.tfstate` in the bucket |
| `beta/` | The beta. One `t4g.small` EC2 server runs the app with SQLite behind Caddy. | `beta/terraform.tfstate` in the bucket |
| `main/` | The parked production stack. ECS Fargate, an Application Load Balancer and optional RDS PostgreSQL. | `main/terraform.tfstate` in the bucket |

`main/` reads `shared/` through `terraform_remote_state`, so apply `shared/` first. `beta/` reads nothing from `shared/` and pulls `ghcr.io/derekhertz/after-class`.

The beta server has no SSH and no key pair. Session Manager is the way in. Ports 80 and 443 are open to `ingress_cidrs` only. A 20 GB data volume with `prevent_destroy` is mounted at `/data`, and a daily snapshot policy keeps 7. The systemd units `afterclass-app` and `afterclass-caddy` run the two containers. The app keeps its database in `/data/db`, and Caddy keeps its certificates in `/data/caddy`. Container logs go to the CloudWatch log group `/afterclass-beta`, in the streams `app` and `caddy`, for 14 days.

## Beta variables

- `ingress_cidrs` is required. Use `["<your public IP>/32"]` until sign-in lands, then `["0.0.0.0/0"]`.
- `clerk_publishable_key` is required. It is the public `pk_live_...` or `pk_test_...` key from Clerk's API keys page. Keep it in `infra/beta/terraform.tfvars`, which git ignores.
- `domain` defaults to `null`, which serves HTTP only on the Elastic IP. Set it to the apex domain to turn on HTTPS. Its Route 53 hosted zone must exist.
- `sslip_https` defaults to `false`. Set it to `true` with no domain to serve HTTPS on `<elastic-ip-with-dashes>.sslip.io`. `domain` and `sslip_https` both need `ingress_cidrs` to include `0.0.0.0/0`, because Let's Encrypt validates from the internet.
- `availability_zone` defaults to `us-east-2a` and is pinned, so the data volume never moves when zone offerings change.
- `caddy_image` is pinned by version and digest. To update it, change both.
- `extension_id` defaults to `null`, which lets no extension connect. For the beta, set it to `jambcaokhnaonnemlbpnppijaojlohgl`, the id of the hosted build from `AFTERCLASS_EXT_BACKEND=https://useafterclass.com bun run build:ext`. Change it to the Chrome Web Store id once the listing exists.
- `alarm_email` defaults to `null`. Set it to get an email when free space on `/data` drops under `disk_alarm_free_mib`, default 4096. AWS sends a confirmation email first, and the alarm sends nothing until you open its link.

The app settings `AFTERCLASS_USER_QUOTA_MB`, default 512, and `AFTERCLASS_MIN_FREE_MB`, default 2048, set the ingest limits. Below the free-space floor, ingest answers 503. The Caddyfile's 8 MiB `request_body` limit matches `MAX_BODY_BYTES` in `src/backend/http.ts`, so change both together.

Any change to `user_data` replaces the instance with a few minutes of downtime. That includes `domain`, `sslip_https`, `extension_id`, the Caddyfile, the units and the scripts. The Elastic IP, the data volume and the certificates stay, and the new instance starts the last deployed image. A new Amazon Linux release does not replace it. Replace it on purpose with `terraform apply -replace=aws_instance.beta`.

## First setup

1. Create the state bucket, unless `bootstrap/` already ran.

   ```
   cd infra/bootstrap
   terraform init
   terraform plan
   terraform apply
   ```

   Keep `infra/bootstrap/terraform.tfstate`. Git ignores it, and losing it means importing the bucket by hand.

2. Skip `shared/`. Only `main/` needs it.

3. Store the app's keys in Parameter Store, then create the beta server. The keys must exist before the plan, because the `aws/ssm` key that Terraform looks up appears with the account's first SecureString parameter. Each command reads the value without echo and passes it on stdin. A value must be one line of printable characters without spaces or quotes.

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

   The new data volume is blank and boot never formats, so cloud-init stops at the mount and leaves the app and Caddy stopped. The failed `runcmd` in the cloud-init log is expected.

   Wait a few minutes for the instance to register with Systems Manager. Then format the data volume and finish the setup. The volume id is the confirmation.

   ```
   aws ssm send-command --instance-ids <instance_id output> --document-name AWS-RunShellScript \
     --parameters 'commands=["/usr/local/sbin/afterclass-format-data <data_volume_id output> && /usr/local/sbin/afterclass-bootstrap"]' \
     --query Command.CommandId --output text
   aws ssm get-command-invocation --instance-id <instance_id output> --command-id <command id from above> \
     --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
   ```

   The status must be `Success`, and the output must end with `afterclass-bootstrap: done`. Caddy then answers 502 until the first deploy. Run the format only on a brand-new data volume, never on a replacement instance or a restored volume.

4. Cut the first release, `v0.1.0`, as in "Releases" below. GHCR creates the package as private, and the server pulls without a sign-in, so make it public once. On GitHub, open the profile's **Packages** tab, then `after-class`, then **Package settings**. Under **Danger Zone**, choose **Change visibility**, then **Public**. The image holds no keys.

5. Deploy the release from the root of a clone. The app makes live calls, so the flow document's conditions for the first hosted live call apply. Running the script is the deploy approval.

   ```
   aws login
   scripts/deploy-beta.sh v0.1.0
   ```

   From an allowed address, `curl <public_url>/health` returns `{"ok":true}`.

6. To open a shell, run `aws ssm start-session --target <instance_id output>`. This needs the Session Manager plugin for the AWS CLI.

## Keys

The app needs `TYPESAFE_API_KEY` and `AFTERCLASS_ANTHROPIC_API_KEY`, stored as SecureString parameters under `/afterclass/beta/`. ElevenLabs is off in the beta. No key is in Terraform, its state, `user_data`, the image or the data volume.

At each start of `afterclass-app`, `afterclass-fetch-keys` reads the parameters and writes `keys.env` to `/run/afterclass-app`, a tmpfs folder that the app mounts read-only at `/data/config`. A missing or malformed parameter fails the start with a line starting `afterclass-fetch-keys:` in `journalctl -u afterclass-app`, and systemd retries every 5 seconds.

To rotate a key, rerun its step 3 command, then run `systemctl restart afterclass-app` in a Session Manager shell. A deploy restarts the app too.

The optional parameter `AFTERCLASS_BUDGET_UNCAPPED_USERS` lists Clerk user ids, comma separated, that skip the $5 per user cap and are left out of the $50 total, per issue #246. The stop switch still halts them. Copy each id, which starts with `user_`, from the Clerk dashboard. An email does not work, because the session token carries only the id. Restart the app after setting it. To end the exemption, delete the parameter and restart.

```
read -r ADMIN_IDS && printf '%s' "$ADMIN_IDS" | aws ssm put-parameter --region us-east-2 --type SecureString \
  --overwrite --name /afterclass/beta/AFTERCLASS_BUDGET_UNCAPPED_USERS --value file:///dev/stdin && unset ADMIN_IDS
```

## Releases

A release is a `v<major>.<minor>.<patch>` tag on a `master` commit whose `package.json` has the same version. A deploy uses the image digest that the release workflow records in the tag's GitHub Release, never a GHCR tag, because GHCR tags are mutable.

1. Before the first release, restrict who can publish.

   - Apply the tag ruleset, so only the repository admin can create, move or delete a `v*` tag.

     ```
     gh api --method POST repos/DerekHertz/after-class/rulesets --input infra/github/tag-ruleset.json
     ```

   - In the package's **Package settings**, under **Manage Actions access**, keep `DerekHertz/after-class` as the only repository, with the **Write** role. Under **Manage access**, give no other account or repository write access. The package exists only after the first image push, so check again before the first deploy.
   - `test/release-workflow.test.ts` fails when any workflow other than the `image` job of `release.yml` asks for `packages: write`, or when a workflow leaves its token's permissions to the repository default.

   This leaves every repository writer and every workflow with `contents: write` trusted, because either can replace a release's `image-digest.txt`. The admin bypasses the ruleset, so never move a pushed release tag.

2. In a pull request, set `version` in `package.json` to the new version, and merge it.
3. Tag the merge commit and push the tag.

   ```
   git switch master && git pull
   git tag -a v0.1.0 -m v0.1.0
   git push origin v0.1.0
   ```

   The `release` workflow checks the tag against `master` and the package version, builds the commit for `linux/arm64`, and pushes `ghcr.io/derekhertz/after-class:<commit>` and `:<tag>`. It then writes the GitHub Release with `image-digest.txt`, which reads `commit <commit>` and `digest sha256:<64 hex>`. Any registry error fails the run. A rerun builds and pushes a new digest.

4. When the `release` run is green, deploy the tag.

   ```
   aws login
   scripts/deploy-beta.sh v0.1.0
   ```

   The script needs `git`, `bun`, `gh`, `curl` and the AWS CLI. It refuses a tag off `master` or with another `package.json` version, a release without a valid `image-digest.txt` for the tag's commit, and a digest that GHCR does not serve anonymously. It then runs the `afterclass-beta-deploy` document on the instance named in `/afterclass-beta/instance_id` and waits up to 15 minutes. Redeploying an older tag is a rollback.

## Turning on HTTPS

Run these in `infra/beta` after the first setup. Each apply replaces the instance. Keep the variables in `terraform.tfvars`, because a later plan without them turns HTTPS off.

With the domain registered and its public Route 53 hosted zone in place:

```
cd infra/beta
terraform plan -var='ingress_cidrs=["0.0.0.0/0"]' -var='domain=useafterclass.com' -out=beta.tfplan
terraform apply beta.tfplan
```

Terraform adds an apex A record for the Elastic IP, and Caddy gets a Let's Encrypt certificate. The `www` name is not served.

Before the domain exists, use sslip.io instead. `domain` wins when both are set.

```
cd infra/beta
terraform plan -var='ingress_cidrs=["0.0.0.0/0"]' -var='sslip_https=true' -out=beta.tfplan
terraform apply beta.tfplan
```

`terraform output public_url` prints the address in both cases.

Caddy passes the client's `Host` header unchanged and replaces any `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` a client sends. The app still applies its localhost Host check, so a public name answers `/health` and nothing else until the hosted sign-in change lands.

## Failure behavior

- A reboot needs no action. `/etc/fstab` mounts `/data` with `nofail`, and the app unit refuses to start without the mount.
- Cloud-init runs `afterclass-bootstrap` once per instance, and a rerun by hand changes nothing that is already right. It never formats. If the mount fails, it exits with an error naming `afterclass-format-data` before it starts either unit.
- `afterclass-format-data` refuses unless its argument is this server's data volume id and the disk shows no filesystem signature. A disk with data and no signature passes those checks, so the real safeguard is to run it only on a brand-new volume.
- On replacement, the new instance waits up to 5 minutes for the data volume. It reads the running image's digest from `/data/afterclass/current-image`, so the app comes back without a deploy.
- A deploy that is not healthy within 90 seconds rolls back to the previous digest, and `scripts/deploy-beta.sh` fails.
- After each healthy deploy or rollback, the server saves the running image to `/data/afterclass/images/` and keeps it and the one before. A replacement instance starts from that copy when GHCR no longer has the image. The save never fails a deploy. When less than the image size plus 2 GiB would stay free, it skips and prints a `WARNING` line that the deploy script shows. Nothing deletes GHCR versions automatically.
- Snapshots are crash-consistent. SQLite recovers from that, but a snapshot taken during a write is not a clean backup.

### Restoring a snapshot

This procedure is untested.

```
aws ec2 create-volume --availability-zone us-east-2a --snapshot-id <snapshot id> --volume-type gp3 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=afterclass-beta-data},{Key=afterclass-snapshot,Value=daily}]'
cd infra/beta
terraform state rm aws_volume_attachment.data aws_ebs_volume.data
terraform import aws_ebs_volume.data <new volume id>
terraform plan -var='ingress_cidrs=["<your public IP>/32"]' -out=beta.tfplan
```

The plan must replace `aws_instance.beta` and `aws_volume_attachment.data` and add only the default tags to the volume. Then apply it. A snapshot from before the first format is blank, and bootstrap stops at the mount. Do not format it. Pick a later snapshot.

## Main stack

`main/` cannot be applied in this account. Its deploy role trusts the OIDC provider in `github_oidc_provider_arn`, which the account cannot create.

- `alb_ingress_cidrs` is required. Use `["<your public IP>/32"]`.
- `github_oidc_provider_arn` is required.
- `create_database` defaults to `false`. The app does not use Postgres yet, and RDS bills around the clock.
- `desired_count` defaults to `1`. Set `0` to stop paying for compute.
- `certificate_arn` defaults to `null`, which serves HTTP only. Set it to add a 443 listener that port 80 redirects to.

Apply `shared/` first, then run these.

```
cd infra/main
terraform init -backend-config="bucket=afterclass-tfstate-<account id>"
terraform plan -var='alb_ingress_cidrs=["<your public IP>/32"]' -var='github_oidc_provider_arn=<arn>' -out=main.tfplan
terraform apply main.tfplan
```

### GitHub setup

`deploy.yml` deploys `main/` in the `production` environment that the deploy role trusts in `infra/main/github.tf`. Before its first run, do both steps.

1. Create the `production` environment with a required reviewer and **Deployment branches** set to `master` only. The role trust cannot see the branch, so this setting keeps other branches out.
2. Add these environment variables. They are not secrets.

   - `AWS_ROLE_ARN` from the `deploy_role_arn` output of `main/`
   - `ECR_REPOSITORY` from the `ecr_repository_name` output of `shared/`
   - `ECS_CLUSTER` from the `ecs_cluster_name` output of `main/`
   - `ECS_SERVICE` from the `ecs_service_name` output of `main/`

The deploy workflow registers each task definition revision, and the service ignores `task_definition` changes, so a later `terraform apply` does not roll a deploy back.

## Monthly cost estimate

These are estimates for 730 hours in `us-east-2`. Figures marked fetched came from AWS pricing pages read on 2026-11-13. Page examples came from worked examples on those pages without a named region. Unverified figures are from memory.

| Beta resource | Estimate | Source |
| --- | --- | --- |
| `t4g.small` on demand, $0.0168 an hour | about $12.26 | unverified |
| Elastic IP, $0.005 an hour | $3.65 | fetched |
| 12 GB root and 20 GB data gp3 at $0.08 per GB-month | about $2.56 | page example |
| Daily snapshots, 7 kept, at $0.05 per GB-month | under $1, at most $7 | page example |
| CloudWatch Logs, $0.50 per GB ingested, 5 GB free | $0 to $1 | page example |
| Route 53 hosted zone, only with a domain | about $0.50 | unverified |
| ECR and GHCR | $0 | unverified |
| Beta total | about $19 to $27 a month | sum of the rows |

The `main/` skeleton without the database is about $35 a month, per `docs/architecture/decision.md`. Data transfer, domain registration and AWS credits were not checked.

## Path to production

- `main/` needs another deploy route, or another account, before it can be applied.
- The data moves from SQLite to PostgreSQL through the Phase 3 importer in `docs/architecture/plan.md`, which reads `/data/db` on the beta server. The importer and the Postgres code path do not exist yet.
- Running more than one task needs Phases 2, 3 and 6 of the plan. Until then the beta stays one process.
- When production is live, snapshot the data volume, confirm the import, remove `prevent_destroy` by hand, and run `terraform destroy` in `beta/`.
