#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname -- "$0")/.."
umask 077
set -o noclobber
if [[ -e .env.vps ]]; then
  printf '%s\n' '.env.vps already exists. Edit that file to update settings.'
  exit 0
fi

db_password=$(openssl rand -hex 32)
db_root_password=$(openssl rand -hex 32)
admin_password=$(openssl rand -hex 20)
jwt_secret=$(openssl rand -hex 32)
webhook_secret=$(openssl rand -hex 32)
webhook_key=$(openssl rand -hex 32)

cat > .env.vps <<EOF
NODE_ENV=production
MYSQL_PASSWORD=$db_password
MYSQL_ROOT_PASSWORD=$db_root_password
ADMIN_EMAIL=
ADMIN_PASSWORD=$admin_password
JWT_SECRET=$jwt_secret
WEBHOOK_SECRET=$webhook_secret
WEBHOOK_API_KEY=$webhook_key
SOURCE_HOST=
DEEPL_API_KEY=
DEEPL_COST_INR_PER_MILLION=0
API_HOST_PORT=8200
WEB_HOST_PORT=8201
EOF

printf '%s\n' 'Created .env.vps with generated secrets. Open it in your editor to complete setup.'
