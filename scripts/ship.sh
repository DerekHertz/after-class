#!/usr/bin/env bash
# Walks you through shipping master to useafterclass.com, one step at a time. Each step shows its command and runs it
# when you press Enter, with the output right below. A step that is already done, such as a pushed tag or a built image,
# says so and is skipped, so you can stop with q and run this again later. The deploy itself is scripts/release.sh,
# which still asks its own y/N. It works on the clone you run it from, so run it from your main clone.
set -uo pipefail
# The AWS CLI pages its output through less on a terminal, which stops the script until someone presses q.
export AWS_PAGER=""

repo=$(git rev-parse --show-toplevel) || exit 1
beta="$repo/infra/beta"
export AWS_PROFILE=afterclass AWS_REGION=us-east-2

if [[ -t 1 ]]; then B=$'\e[1m' D=$'\e[2m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' X=$'\e[0m'; else B= D= G= Y= R= X=; fi
say() { printf '%s\n' "$*"; }

# step <title> <done-check> <shown command> <function>. The check succeeds when the step needs no run.
step() {
  local title=$1 check=$2 shown=$3 run=$4
  printf '\n%s== %s%s\n' "$B" "$title" "$X"
  if "$check"; then say "${G}nothing to do${X}"; return; fi
  printf '%s$ %s%s\n' "$D" "$shown" "$X"
  while true; do
    read -r -p "[Enter] run  [s] skip  [q] quit " key || exit 1
    case $key in
      s) say "${Y}skipped${X}"; return ;;
      q) exit 0 ;;
      "") ;;
      *) continue ;;
    esac
    if "$run"; then say "${G}done${X}"; return; fi
    say "${R}failed. Enter tries again, s skips, q stops.${X}"
  done
}

never() { return 1; }

# The version comes from origin/master, the commit a release must be cut from.
git -C "$repo" fetch -q origin || { say "${R}git fetch failed${X}"; exit 1; }
version=$(git -C "$repo" show origin/master:package.json | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p')
tag="v$version"
say "${B}Shipping $tag${X} ${D}(the version in package.json on master)${X}"

on_master() { [[ $(git -C "$repo" rev-parse HEAD) == $(git -C "$repo" rev-parse origin/master) ]]; }
update_master() { git -C "$repo" switch master && git -C "$repo" pull --ff-only; }
step "Update your master" on_master "git switch master && git pull --ff-only" update_master

tag_pushed() { [[ -n $(git -C "$repo" ls-remote --tags origin "refs/tags/$tag") ]]; }
push_tag() {
  git -C "$repo" rev-parse -q --verify "refs/tags/$tag" >/dev/null || git -C "$repo" tag -a "$tag" -m "$tag" origin/master || return
  git -C "$repo" push origin "$tag"
}
step "Tag $tag" tag_pushed "git tag -a $tag -m $tag origin/master && git push origin $tag" push_tag

image_built() { gh release view "$tag" --json assets -q '.assets[].name' 2>/dev/null | grep -qx image-digest.txt; }
watch_build() {
  local run
  run=$(gh run list --workflow release.yml --branch "$tag" --limit 1 --json databaseId -q '.[0].databaseId')
  [[ -n $run ]] || { say "no release run for $tag yet. Wait a few seconds and try again."; return 1; }
  gh run watch "$run" --exit-status
}
step "Wait for the $tag image to build" image_built "gh run watch <the release run for $tag>" watch_build

signed_in() { aws sts get-caller-identity --query Account --output text >/dev/null 2>&1; }
sign_in() { aws login --profile afterclass --region us-east-2; }
step "Sign in to AWS" signed_in "aws login --profile afterclass --region us-east-2" sign_in

# terraform.tfvars is git-ignored, so a fresh clone lacks it. The newest copy in a sibling clone is offered.
have_tfvars() { [[ -f $beta/terraform.tfvars ]]; }
copy_tfvars() {
  local newest
  newest=$(ls -t "$repo"/../*/infra/beta/terraform.tfvars 2>/dev/null | head -1)
  [[ -n $newest ]] || { say "no terraform.tfvars in a sibling clone. Write $beta/terraform.tfvars by hand."; return 1; }
  say "copying $newest"
  cp "$newest" "$beta/terraform.tfvars"
}
step "Terraform settings" have_tfvars "cp <newest sibling clone>/infra/beta/terraform.tfvars infra/beta/" copy_tfvars

initialized() { [[ -f $beta/.terraform/terraform.tfstate ]]; }
tf_init() {
  local account
  account=$(aws sts get-caller-identity --query Account --output text) || return
  terraform -chdir="$beta" init -input=false -backend-config="bucket=afterclass-tfstate-$account"
}
step "Connect Terraform to its state" initialized "terraform init -backend-config=bucket=afterclass-tfstate-<account>" tf_init

# plan -detailed-exitcode exits 0 for no changes and 2 for changes. The apply step reads which one happened.
plan_status=unknown
tf_plan() {
  terraform -chdir="$beta" plan -input=false -detailed-exitcode -out=beta.tfplan
  case $? in
    0) plan_status=none ;;
    2) plan_status=changes ;;
    *) return 1 ;;
  esac
  if terraform -chdir="$beta" show -no-color beta.tfplan | grep -E '# aws_(ebs_volume|eip|network_interface)\.[^ ]+ .*(destroyed|replaced)'; then
    say "${R}This plan destroys the data volume or the public address. Do not apply it.${X}"
    plan_status=dangerous
  fi
}
step "Plan the server changes" never "terraform plan -out=beta.tfplan" tf_plan

nothing_to_apply() {
  [[ $plan_status == unknown ]] && say "no plan was made this run, so there is nothing to apply."
  [[ $plan_status == none || $plan_status == unknown ]]
}
tf_apply() {
  [[ $plan_status == dangerous ]] && { say "refusing: the plan destroys the data volume or the public address."; return 1; }
  read -r -p "This replaces the server if the plan says so, with a few minutes of downtime. Type apply: " word
  [[ $word == apply ]] || { say "not applied"; return 1; }
  terraform -chdir="$beta" apply -input=false beta.tfplan
}
step "Apply the plan" nothing_to_apply "terraform apply beta.tfplan" tf_apply

deploy() { (cd "$repo" && scripts/release.sh "$tag"); }
step "Try and deploy $tag" never "scripts/release.sh $tag" deploy

say ""
say "${G}Finished.${X}"
