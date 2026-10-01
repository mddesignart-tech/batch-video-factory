import { notFound } from "next/navigation";
import { buildWorkspace } from "@/services/daily-workspace";
import { WorkspaceView } from "./workspace-view";

export const dynamic = "force-dynamic";

/**
 * One batch in the daily workspace (V1.2 Phase 6, QĐ-114). Server-rendered once
 * from the database, then kept current by the client polling the same builder.
 */
export default async function BatchWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await buildWorkspace(id);
  if (!workspace) notFound();
  return <WorkspaceView initial={JSON.parse(JSON.stringify(workspace))} />;
}
