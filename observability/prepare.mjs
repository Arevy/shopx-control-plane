import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const source = path.dirname(fileURLToPath(import.meta.url));
export function prepareObservability(
	directory,
	{ controlUrl = "http://api:4100", oracleContainer = "oracle19" } = {}
) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	const privateFile = path.join(directory, "credentials.private.json");
	const credentials = fs.existsSync(privateFile)
		? JSON.parse(fs.readFileSync(privateFile, "utf8"))
		: {
				token: randomBytes(32).toString("hex"),
				grafanaPassword: randomBytes(24).toString("base64url"),
		  };
	if (
		!/^[a-f0-9]{64}$/.test(credentials.token) ||
		typeof credentials.grafanaPassword !== "string" ||
		credentials.grafanaPassword.length < 24
	)
		throw new Error("Restore original observability credentials");
	const write = (name, value, mode = 0o644) => {
		const file = path.join(directory, name);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
		if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
		fs.writeFileSync(file, value, { mode });
		fs.chmodSync(file, mode);
	};
	write(
		"credentials.private.json",
		JSON.stringify(credentials, null, 2) + "\n",
		0o600
	);
	// Readable by the non-root Grafana/Prometheus container UIDs; their host parent
	// directory stays 0700. The API's private config remains a separate 0600 file.
	write("token", credentials.token, 0o444);
	write("grafana-password", credentials.grafanaPassword, 0o444);
	for (const file of ["loki.yaml", "config.alloy", "rules.yaml"])
		write(file, fs.readFileSync(path.join(source, file)));
	const config = {
		token: credentials.token,
		lokiUrl: "http://obs-loki:3100",
		prometheusUrl: "http://obs-prometheus:9090",
		collectorUrl: "http://obs-collector:4200",
		grafanaUrl: "http://localhost:3201",
	};
	write("api.private.json", JSON.stringify(config, null, 2) + "\n", 0o600);
	write(
		"collector.private.json",
		JSON.stringify(
			{
				...config,
				controlUrl,
				oracleContainer,
				alloyUrl: "http://obs-alloy:3500",
			},
			null,
			2
		) + "\n",
		0o600
	);
	const control = new URL(controlUrl);
	write(
		"prometheus.yaml",
		`global:\n  scrape_interval: 30s\n  evaluation_interval: 30s\nrule_files: [/etc/prometheus/rules.yaml]\nscrape_configs:\n  - job_name: shopx-control\n    metrics_path: /internal/observability/metrics\n    authorization:\n      credentials_file: /run/secrets/telemetry-token\n    static_configs: [{targets: [${JSON.stringify(
			control.host
		)}]}]\n  - job_name: shopx-collector\n    authorization:\n      credentials_file: /run/secrets/telemetry-token\n    static_configs: [{targets: ["obs-collector:4200"]}]\n  - job_name: alloy\n    static_configs: [{targets: ["obs-alloy:12345"]}]\n  - job_name: loki\n    static_configs: [{targets: ["obs-loki:3100"]}]\n`
	);
	write(
		"provisioning/datasources/shopx.yaml",
		`apiVersion: 1\ndatasources:\n  - name: ShopX metrics\n    uid: shopx-metrics\n    type: prometheus\n    access: proxy\n    url: http://obs-prometheus:9090\n    isDefault: true\n    editable: false\n  - name: ShopX logs\n    uid: shopx-logs\n    type: loki\n    access: proxy\n    url: http://obs-collector:4200/loki\n    editable: false\n    jsonData:\n      httpHeaderName1: Authorization\n      maxLines: 200\n    secureJsonData:\n      httpHeaderValue1: ${JSON.stringify(
			"Bearer " + credentials.token
		)}\n`
	);
	write(
		"provisioning/dashboards/shopx.yaml",
		"apiVersion: 1\nproviders:\n  - name: ShopX\n    folder: ShopX\n    type: file\n    disableDeletion: true\n    editable: false\n    options:\n      path: /var/lib/grafana/dashboards\n"
	);
	const datasource = { type: "prometheus", uid: "shopx-metrics" };
	const panel = (id, title, type, expr, x, y, w = 12, h = 7) => ({
		id,
		title,
		type,
		datasource,
		gridPos: { x, y, w, h },
		targets: [
			{ refId: "A", expr, legendFormat: "{{platform_id}} / {{service}}" },
		],
		fieldConfig: { defaults: { min: 0 }, overrides: [] },
		options: { legend: { displayMode: "table" } },
	});
	const dashboard = {
		uid: "shopx-overview",
		title: "ShopX · Service health and logs",
		schemaVersion: 39,
		version: 1,
		editable: false,
		refresh: "30s",
		tags: ["shopx"],
		time: { from: "now-1h", to: "now" },
		templating: {
			list: [
				{
					name: "platform",
					label: "Platform",
					type: "query",
					datasource,
					query: "label_values(shopx_container_running, platform_id)",
					refresh: 1,
					multi: false,
					includeAll: true,
					allValue: ".+",
					current: { text: "All", value: "$__all" },
				},
			],
		},
		panels: [
			panel(
				1,
				"Container running · not a readiness guarantee",
				"stat",
				'shopx_container_running{platform_id=~"$platform"}',
				0,
				0,
				24,
				5
			),
			panel(
				2,
				"Dependency readiness history",
				"state-timeline",
				'shopx_service_ready{platform_id=~"$platform"}',
				0,
				5,
				24,
				7
			),
			panel(
				3,
				"Memory bytes",
				"timeseries",
				'shopx_container_memory_bytes{platform_id=~"$platform"}',
				0,
				12
			),
			panel(
				4,
				"CPU percent",
				"timeseries",
				'shopx_container_cpu_percent{platform_id=~"$platform"}',
				12,
				12
			),
			panel(
				5,
				"Active alerts",
				"table",
				'ALERTS{alertstate="firing"}',
				0,
				19,
				24,
				6
			),
			{
				id: 6,
				title: "Sanitized operational logs",
				type: "logs",
				datasource: { type: "loki", uid: "shopx-logs" },
				gridPos: { x: 0, y: 25, w: 24, h: 12 },
				targets: [{ refId: "A", expr: '{platform_id=~"$platform"}' }],
				options: {
					showTime: true,
					wrapLogMessage: true,
					sortOrder: "Descending",
				},
			},
		],
	};
	// Prometheus table queries expose alert labels as columns. A range query
	// would show only timestamps and values, hiding which alert is firing.
	const alerts = dashboard.panels.find((p) => p.id === 5);
	alerts.targets = [
		{
			refId: "A",
			expr: 'ALERTS{alertstate="firing"}',
			instant: true,
			range: false,
			format: "table",
		},
	];
	alerts.options = { showHeader: true };
	alerts.transformations = [
		{
			id: "organize",
			options: {
				excludeByName: {
					Time: true,
					__name__: true,
					Value: true,
					job: true,
					instance: true,
					alertstate: true,
				},
				indexByName: { alertname: 0, severity: 1, platform_id: 2 },
				renameByName: {
					alertname: "Alert",
					severity: "Severity",
					platform_id: "Platform",
				},
			},
		},
	];
	write("dashboards/shopx.json", JSON.stringify(dashboard, null, 2) + "\n");
	return config;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const directory = path.resolve(
		process.argv[2] || path.join(source, "../.local/observability")
	);
	prepareObservability(directory, {
		controlUrl: process.env.CONTROL_API_ORIGIN,
		oracleContainer: process.env.ORACLE_CONTAINER,
	});
	console.log(
		"Observability prepared; credentials are in the private directory. No credentials printed."
	);
}
