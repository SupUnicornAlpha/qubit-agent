import { type FC } from "react";
import { FsWorkspaceExplorer } from "../../components/workspace/FsWorkspaceExplorer";

/** pro 壳 SideBar：挂载 FS 课题树 */
export const ExplorerWorkspaceTree: FC = () => {
  return <FsWorkspaceExplorer compact />;
};
