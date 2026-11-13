# Infrastructure

Terraform for the hosted skeleton (`docs/architecture/plan.md`, Phase 4). It deploys the backend in replay mode, with no provider keys, behind a load balancer that Derek's address alone can reach. Region is `us-east-2`, because the account's organization denies these services in every other region. Terraform 1.17.1 and the `hashicorp/aws` provider 6.71.0 are the tested versions.

Nothing here has been planned or applied. Derek runs every command below, with `AWS_PROFILE=afterclass`.

## What each stack creates

`bootstrap/` runs once, with local state.

- An S3 bucket `afterclass-tfstate-<account id>` for the main stack's state. It is versioned, encrypted with SSE-S3, closed to public access, refuses plain HTTP, and expires old state versions after 90 days.

`main/` keeps its state in that bucket, with S3 native locking (`use_lockfile`).

- A VPC with two public subnets in two zones, an internet gateway and no NAT gateway.
- Security groups. The load balancer admits port 80 from `alb_ingress_cidrs` only. The tasks admit the load balancer only. The database group admits the tasks only.
- An Application Load Balancer with a target group that checks `GET /health`. The idle timeout is 300 seconds, longer than the backend's 5-minute turn deadline. The target group waits 120 seconds before it drops a task, so a turn in progress can finish.
- An ECR repository with scan on push, immutable tags and a lifecycle rule that keeps the 10 newest images.
- An ECS cluster and one Fargate service on ARM, 0.25 vCPU and 0.5 GB, `desired_count` 1, with a deployment circuit breaker that rolls back. The execution role can pull from this repository and write to this log group. The task role has no permissions yet.
- A CloudWatch log group with 14 days of retention.
- A GitHub OIDC provider and a deploy role. Only a job in `DerekHertz/after-class` running in the `production` environment can assume it. The role can push to this repository, register a task definition, update this service and pass the two task roles.
- When `create_database = true`, an RDS PostgreSQL 17 instance on `db.t4g.micro`, single zone, 20 GB gp3, encrypted, not publicly accessible, deletion protection on, 7 days of backups, and a master password that RDS keeps in Secrets Manager.

## Opt-in and tuning variables

- `alb_ingress_cidrs` is required and has no default. Use `["<your public IP>/32"]`.
- `create_database` defaults to `false`. The app does not use Postgres yet, and the instance bills around the clock.
- `desired_count` defaults to `1`. Set `0` to stop paying for compute and keep everything else.
- `certificate_arn` defaults to `null`, which serves HTTP only. When a domain and an ACM certificate exist, set it and the load balancer adds a 443 listener and redirects port 80 to it.

## Commands, in order

1. Create the state bucket.

   ```
   cd infra/bootstrap
   terraform init
   terraform plan
   terraform apply
   ```

   Keep `infra/bootstrap/terraform.tfstate`. It is ignored by git. Losing it means importing the bucket by hand, and the bucket has `prevent_destroy`.

2. Initialize the main stack against that bucket. Use the `state_bucket` output from step 1.

   ```
   cd ../main
   terraform init -backend-config="bucket=afterclass-tfstate-<account id>"
   ```

3. Plan, then apply after reading the plan.

   ```
   terraform plan -var='alb_ingress_cidrs=["<your public IP>/32"]' -out=main.tfplan
   terraform apply main.tfplan
   ```

4. In GitHub, create the `production` environment with Derek as the required reviewer, then add these environment variables from the stack outputs. They are not secrets.

   - `AWS_ROLE_ARN` from `deploy_role_arn`
   - `ECR_REPOSITORY` from `ecr_repository_name`
   - `ECS_CLUSTER` from `ecs_cluster_name`
   - `ECS_SERVICE` from `ecs_service_name`

5. Run the `deploy` workflow from `master` and approve it. Until it runs, the ECR repository is empty, so the service cannot start its first task and `terraform apply` does not wait for it. After the deploy, `curl http://<alb_dns_name>/health` from the allowed address returns `{"ok":true}`.

Terraform does not own the running task definition revision. The deploy workflow registers each revision, and the service ignores `task_definition` changes, so a later `terraform apply` does not roll a deploy back.

## Monthly cost estimate

Prices are for `us-east-1`, 730 hours a month. For these services `us-east-2` is assumed to match (unverified). Figures marked `decision.md` come from `docs/architecture/decision.md`, which took them from worked examples on the AWS pricing pages. Figures marked unverified are from memory and were not checked against a pricing page.

| Resource | Estimate | Source |
| --- | --- | --- |
| Fargate ARM task, 0.25 vCPU and 0.5 GB, always on | about $7.21 | `decision.md` |
| Application Load Balancer, before load capacity charges | about $16.43 | `decision.md` |
| Public IPv4 addresses, 2 on the load balancer and 1 on the task, at $0.005 an hour each | about $11 | unverified, and not in `decision.md` |
| CloudWatch Logs, ECR storage, state bucket | under $1 at this size | unverified |
| Skeleton without the database | about $35 | sum of the rows above |
| RDS `db.t4g.micro`, single zone, 20 GB gp3, 7 days of backups, only with `create_database` | about $15 to $20 | unverified, `decision.md` did not read the RDS rates |
| Secrets Manager secret for the RDS password, only with `create_database` | about $0.40 | unverified |

Whether the AWS free plan or its credits cover any of this is unverified.
