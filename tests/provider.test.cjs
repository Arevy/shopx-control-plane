const { test } = require("node:test"),
	assert = require("node:assert/strict"),
	http = require("node:http");
const { gatewayRequest } = require("../dist/provider");
test("gateway probe preserves the virtual Host header instead of checking the default server", async () => {
	const server = http
		.createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ host: req.headers.host, method: req.method }));
		})
		.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	try {
		const result = await gatewayRequest(
			"http://127.0.0.1:" + server.address().port + "/graphql",
			"api.northstar.localhost:9200",
			"{}"
		);
		assert.deepEqual(await result.json(), {
			host: "api.northstar.localhost:9200",
			method: "POST",
		});
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
