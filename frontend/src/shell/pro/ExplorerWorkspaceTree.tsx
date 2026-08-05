import { type FC } from "react";
import { FsWorkspaceExplorer } from "../../components/workspace/FsWorkspaceExplorer";
import { useAppStore } from "../../store";

/** pro 壳 SideBar：挂载 FS 课题树；打开文件 → IDE Monaco（研究团队页仍走 pending 消费） */
export const ExplorerWorkspaceTree: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingWorkspaceFile = useAppStore((s) => s.setPendingWorkspaceFile);
  const setIdeLeftTab = useAppStore((s) => s.setIdeLeftTab);

  return (
    <FsWorkspaceExplorer
      compact
      onOpenFile={({ workspaceId, path }) => {
        setPendingWorkspaceFile({ workspaceId, path });
        setIdeLeftTab("editor");
        if (activeView === "team") return;
        setActiveView("ide");
      }}
    />
  );
};
