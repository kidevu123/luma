#!/bin/bash
# Run on LXC 122 to add HTTPS (required for camera on iOS Safari).
# Usage: ssh root@192.168.1.190 'pct exec 122 -- bash -s' < setup-https.sh

set -e

apt-get install -y nginx openssl -qq

mkdir -p /etc/nginx/ssl

openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/luma.key \
  -out /etc/nginx/ssl/luma.crt \
  -subj "/CN=192.168.1.134" \
  -addext "subjectAltName=IP:192.168.1.134" 2>/dev/null

cat > /etc/nginx/sites-available/luma <<'NGINX'
server {
    listen 443 ssl;
    server_name 192.168.1.134;

    ssl_certificate     /etc/nginx/ssl/luma.crt;
    ssl_certificate_key /etc/nginx/ssl/luma.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 20M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_cache_bypass $http_upgrade;
    }
}

server {
    listen 80;
    server_name 192.168.1.134;
    return 301 https://$host$request_uri;
}
NGINX

ln -sf /etc/nginx/sites-available/luma /etc/nginx/sites-enabled/luma
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl enable nginx && systemctl restart nginx

echo "HTTPS ready at https://192.168.1.134"
echo "On each tablet: accept the self-signed cert warning once, then camera works."
