/**
 * Who can reach this repository (note #566). A repository belongs to the
 * workplace, exactly as a Drive file does: there is no room to share it with
 * and nothing to pick, so what used to be the room-access card (note #108) is
 * one sentence saying where the wall is. Drive says the same of its files.
 * It named "every agent in every room" until rooms left the product (note
 * #843).
 */
import { useWorkspace } from '../../workspace/useWorkspace.js';

export function RepoRooms({ repoName }: { repoName: string }) {
  const { state } = useWorkspace();
  const repo = (state?.repos ?? []).find((entry) => entry.name === repoName) ?? null;
  if (!repo || !state?.org) return <div className="formhint" id="repoRoomHint" hidden />;
  return (
    <div className="formhint" id="repoRoomHint">
      Everyone in the workplace, and every agent in it, can see, clone and push this repository.
    </div>
  );
}
