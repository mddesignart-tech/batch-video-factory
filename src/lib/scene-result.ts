import type { ActionResult } from "@/components/action-ui";

/**
 * An action's message, tagged with the scene it was started from.
 *
 * The storyboard shows one scene at a time but keeps one message line. Untagged,
 * "Cảnh 5 dùng ảnh nhập" stayed on screen after switching to scene 1 - and an
 * action still running when the person switched landed under the wrong scene.
 */
export interface SceneResult {
  sceneId: string;
  result: ActionResult;
}

/** The message to show for the scene on screen; another scene's is never shown. */
export function resultForScene(current: SceneResult | null, sceneId: string): ActionResult | null {
  return current && current.sceneId === sceneId ? current.result : null;
}
