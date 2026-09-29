// Talking to the pi-web server.

const TOKEN = document.querySelector('meta[name="pi-web-token"]')?.content || "";

export async function post(path, body) {
	const res = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Pi-Web-Token": TOKEN },
		body: JSON.stringify(body ?? {}),
	});
	let data = null;
	try {
		data = await res.json();
	} catch {
		// empty or non-JSON body
	}
	if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
	return data;
}

export async function getJson(path) {
	const res = await fetch(path, { headers: { Accept: "application/json" } });
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
	return data;
}

/** Send one pi RPC command for a session; resolves with the command's data. */
export async function rpc(session, command) {
	const res = await post("/api/command", { session, command });
	return res?.data;
}

export function streamUrl(sessionId) {
	const params = new URLSearchParams({ token: TOKEN });
	if (sessionId) params.set("session", sessionId);
	return `/api/stream?${params}`;
}

export function imageUrl(sessionId, block) {
	if (block?.ref) return `/api/image?session=${encodeURIComponent(sessionId)}&ref=${encodeURIComponent(block.ref)}`;
	if (block?.path) return `/api/file?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(block.path)}`;
	if (block?.data) return `data:${block.mimeType || "image/png"};base64,${block.data}`;
	return "";
}
