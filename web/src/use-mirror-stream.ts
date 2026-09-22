import { useEffect, useRef, useState, useCallback } from 'react';

// iPhone 镜像共享流生命周期：必须在会话虚拟列表之外持有——
// 列表滚动会把行组件卸载重挂，若流挂在行内，卸载即 stop tracks 断流。
// stream 升为 state（非 ref）：MirrorRow 需要凭它挂载/重挂并重绑 srcObject。
export function useMirrorStream() {
  const streamRef = useRef<MediaStream | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  // 卸载回收，避免浏览器工具栏残留"正在共享屏幕"指示条
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  // 返回 null 表示未建立（能力缺失或用户在选择器点了取消：静默保持 idle，不算错误）
  const start = useCallback(async (): Promise<MediaStream | null> => {
    if (!navigator.mediaDevices?.getDisplayMedia) return null;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = s;
      // 用户点浏览器工具栏"停止共享"时 track 触发 ended，走统一回收
      s.getVideoTracks()[0].addEventListener('ended', stop);
      setStream(s);
      return s;
    } catch {
      return null;
    }
  }, [stop]);

  return { stream, start, stop };
}
