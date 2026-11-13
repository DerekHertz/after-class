# The one image repository for the beta and the future ECS stack, so the same image moves between them.
resource "aws_ecr_repository" "api" {
  name = "${var.name}-api"

  # The deploy workflow tags every image with its commit SHA, so a tag never changes.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Retention is housekeeping only. The beta server saves the running image and its predecessor on its data volume
# (afterclass-save-image), so an expired tag never stops a replaced instance from starting. The ECS stack pulls a tag
# when a task starts, and 20 images cover any rollback it would make.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 20 newest images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}
