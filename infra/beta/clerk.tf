# A Clerk publishable key is pk_live_ or pk_test_ and the base64 of the Frontend API host followed by "$". Clerk drops
# the base64 padding and base64decode requires it, so both the check and the decode put it back. test/beta-clerk.test.ts
# evaluates this file alone in terraform console.

variable "clerk_publishable_key" {
  description = "The Clerk application's publishable key, pk_live_... or pk_test_..., from Clerk's API keys page. It is public, not a secret. The issuer and the JWKS URL are derived from it."
  type        = string

  validation {
    condition = try(alltrue([
      for b in regex("^pk_(?:live|test)_([A-Za-z0-9+/]+)={0,2}$", var.clerk_publishable_key) :
      endswith(base64decode("${b}${substr("==", 0, (4 - length(b) % 4) % 4)}"), "$")
    ]), false)
    error_message = "clerk_publishable_key must be pk_live_ or pk_test_ followed by the base64 of a host and \"$\"."
  }
}

locals {
  clerk_key_base64   = regex("^pk_(?:live|test)_([A-Za-z0-9+/]+)={0,2}$", var.clerk_publishable_key)[0]
  clerk_key_padded   = "${local.clerk_key_base64}${substr("==", 0, (4 - length(local.clerk_key_base64) % 4) % 4)}"
  clerk_frontend_api = "https://${trimsuffix(base64decode(local.clerk_key_padded), "$")}"
}
