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

# The deploy workflow adds a live-<commit> tag to an image after the server reports it healthy. Tags are immutable, so
# nothing is re-tagged. A second tag on the same image is a new name. ECR never expires an image through a rule of
# lower priority when the image matches the tag requirements of a higher one, so rule 2 shields the live- images from
# the count rule 3, and expires all but the 3 newest of them. Those 3 are the running image, the one it replaced and one
# spare. A count rule alone could expire the running image after ten newer pushes, and a replaced instance could then
# not pull it.
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
        description  = "Keep the 3 newest live- images and shield them from every lower rule"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["live-"]
          countType     = "imageCountMoreThan"
          countNumber   = 3
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 3
        description  = "Keep the 10 newest images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      },
    ]
  })
}
