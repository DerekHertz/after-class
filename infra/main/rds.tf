# Opt in with create_database = true. The app does not use Postgres yet, so nothing connects to this.
# The subnets are the public ones (RDS needs two zones), but the instance is not publicly accessible and its security
# group admits only the API tasks.

resource "aws_db_subnet_group" "main" {
  count = var.create_database ? 1 : 0

  name       = var.name
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_db_instance" "main" {
  count = var.create_database ? 1 : 0

  identifier     = var.name
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.db_instance_class

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "afterclass"
  username = "afterclass"

  # RDS creates and rotates the master password in Secrets Manager. Terraform never sees it.
  manage_master_user_password = true

  multi_az               = false
  publicly_accessible    = false
  db_subnet_group_name   = aws_db_subnet_group.main[0].name
  vpc_security_group_ids = [aws_security_group.db[0].id]

  backup_retention_period    = 7
  auto_minor_version_upgrade = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-final"
  copy_tags_to_snapshot      = true
}
