// Only factory-generated hostnames enter this configuration.
export function gatewayConfiguration(hostname: string) {
	if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(hostname))
		throw new Error("Invalid gateway hostname");
	const proxy = (target: string) => `proxy_pass http://${target};
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header x-middleware-subrequest "";
proxy_hide_header X-Powered-By;`;
	return `log_format shopx escape=json '{"level":"info","event":"http_request","message":"Gateway request completed","method":"$request_method","status":$status,"duration_seconds":$request_time}';
server_tokens off;
client_header_timeout 10s;
client_body_timeout 15s;
send_timeout 30s;
proxy_connect_timeout 5s;
proxy_read_timeout 60s;
proxy_send_timeout 60s;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
server { listen 80 default_server; access_log /var/log/nginx/access.log shopx; server_name _; return 404; }
server { listen 80; access_log /var/log/nginx/access.log shopx; server_name api.${hostname}; client_max_body_size 6m;
 location / { ${proxy("backend:4000")} } }
server { listen 80; access_log /var/log/nginx/access.log shopx; server_name admin.${hostname}; client_max_body_size 6m;
 location ~ ^/products/[0-9]+/image$ { ${proxy("backend:4000")} }
 location / { ${proxy("admin:3000")} } }
server { listen 80; access_log /var/log/nginx/access.log shopx; server_name ${hostname};
 location ~ ^/products/[0-9]+/image$ { ${proxy("backend:4000")} }
 location = /graphql { ${proxy("backend:4000")} }
 location / { ${proxy("storefront:3100")} } }
`;
}
