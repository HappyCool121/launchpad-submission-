export function getAdRouterUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `adrouter/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
