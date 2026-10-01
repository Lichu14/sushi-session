import { merchantProxy } from "../../../../lib/merchant-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return merchantProxy(
    request,
    (await context.params).path,
    process.env.API_URL,
  );
}
export { handle as GET, handle as POST };
