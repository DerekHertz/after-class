import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SceneId } from "./appearance";

const WIDTH = 1672;
const HEIGHT = 941;

export function HDRoomStage({ children, scene }: { readonly children: ReactNode; readonly scene: SceneId }) {
  const container = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const resize = () => setScale(node.clientWidth / WIDTH);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return <div className="hd-room" ref={container} data-paused={hidden} data-scene={scene}>
    <div className="hd-room-stage" data-scene={scene} style={{ width: WIDTH, height: HEIGHT, transform: `scale(${scale})` }}>
      <div className="hd-room-art" aria-hidden="true">
        <div className="hd-room-base" />
        {scene === "projection-booth" ? <>
          <div className="hd-room-projection-glow" />
          <div className="hd-room-projection-dust"><i /><i /><i /></div>
        </> : <>
          <div className="hd-room-exterior" />
          <div className="hd-room-board-shade" />
        </>}
      </div>
      {children}
    </div>
  </div>;
}
