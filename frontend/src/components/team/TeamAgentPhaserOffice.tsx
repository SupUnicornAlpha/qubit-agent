import type { FC } from "react";
import { useEffect, useMemo, useRef } from "react";
import type {
  AnalystTeamGraphEdge,
  AnalystTeamGraphNode,
  AnalystTeamGraphPayload,
} from "../../api/types";
import {
  createPhaserOffice,
  type PhaserOfficeHandle,
} from "../../lib/pixelOffice/phaserOffice";
import type { CitySkyline } from "../../lib/pixelOffice/types";
import type { TeamGraphActivity, TeamGraphSelection } from "../ide/TeamAgentGraph";

const SERVER_ROLE = "__tools__";

type Props = {
  graph: AnalystTeamGraphPayload;
  nodes: AnalystTeamGraphNode[];
  edges: AnalystTeamGraphEdge[];
  selection: TeamGraphSelection;
  onSelectNode: (role: string) => void;
  onClear: () => void;
  activity?: TeamGraphActivity;
  isRunning?: boolean;
  city: CitySkyline;
};

/** Phaser 渲染版像素办公室；与 Canvas 版共用事件映射与精灵图集，
 * 仅在用户切换到 "Phaser 引擎" 时挂载，避免 1.4MB 包默认加载。 */
export const TeamAgentPhaserOffice: FC<Props> = ({
  graph,
  nodes,
  selection,
  onSelectNode,
  onClear,
  isRunning = false,
  city,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<PhaserOfficeHandle | null>(null);
  const onSelectRef = useRef(onSelectNode);
  const onClearRef = useRef(onClear);

  useEffect(() => {
    onSelectRef.current = onSelectNode;
    onClearRef.current = onClear;
  }, [onSelectNode, onClear]);

  const agentNodes = useMemo(() => nodes.filter((n) => n.role !== SERVER_ROLE), [nodes]);

  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;

    void (async () => {
      const handle = await createPhaserOffice(
        el,
        {
          graph,
          nodes: agentNodes,
          city,
          selectedRole: selection?.kind === "node" ? selection.role : null,
          isRunning,
        },
        {
          onSelectRole: (role) => onSelectRef.current(role),
          onClear: () => onClearRef.current(),
        }
      );
      if (cancelled) {
        handle.destroy();
        return;
      }
      handleRef.current = handle;
    })();

    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    h.update({
      graph,
      nodes: agentNodes,
      city,
      selectedRole: selection?.kind === "node" ? selection.role : null,
      isRunning,
    });
  }, [graph, agentNodes, city, selection, isRunning]);

  return (
    <div
      ref={containerRef}
      className="qb-pixel-office qb-pixel-office--fill qb-pixel-office--phaser"
      data-qb-topology-canvas=""
      style={{ position: "relative", width: "100%", height: "100%" }}
    />
  );
};
