import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// 「iPhone 镜像」(Continuity) 进程名(spike 实测,与系统语言无关)
export const MIRROR_PROCESS = 'iPhone Mirroring';

export type SwipeResult =
  | { ok: true }
  | { ok: false; reason: 'window-not-found' | 'inject-failed'; detail?: string };

// ① AppleScript:读当前焦点进程 + 镜像主窗口(面积最大者,过滤 66×20 悬浮小条)几何,
//   并把镜像提为 frontmost——被遮挡时 CGEvent 会被前方窗口吃掉(spike 实测)。
//   输出 "prevFront|x,y,w,h";窗口过小 → "ERR|window-not-found"(此时未抢焦点)
const ASC_PREP = [
  'tell application "System Events"',
  '  set prevFront to name of first application process whose frontmost is true',
  `  tell process "${MIRROR_PROCESS}"`,
  '    set maxA to 0',
  '    set bx to 0',
  '    set by to 0',
  '    set bw to 0',
  '    set bh to 0',
  '    repeat with w in windows',
  '      set {x, y} to position of w',
  '      set {ww, hh} to size of w',
  '      if ww * hh > maxA then',
  '        set maxA to ww * hh',
  '        set bx to x',
  '        set by to y',
  '        set bw to ww',
  '        set bh to hh',
  '      end if',
  '    end repeat',
  '  end tell',
  '  if bw < 50 or bh < 50 then return "ERR|window-not-found"',
  `  set frontmost of process "${MIRROR_PROCESS}" to true`,
  '  delay 0.25',
  '  return prevFront & "|" & (bx as text) & "," & (by as text) & "," & (bw as text) & "," & (bh as text)',
  'end tell',
].join('\n');

// ② JXA:全局 CGEventPost(0 = kCGHIDEventTap)合成 leftDown → 16 步 leftMouseDragged → leftUp,
//   「下部 1/6 → 上部 1/3」。事件常量内联数值(enum 宏不保证被 ObjC bridge 暴露):
//   1/4/6 = leftMouseDown/leftMouseDragged/leftMouseUp,0 = kCGMouseButtonLeft。
//   节奏必需:瞬发序列 Continuity 不认;PostToPid 无效(spike 实测)
const JXA_SWIPE = `
ObjC.import('CoreGraphics');
ObjC.import('unistd');
function run(argv) {
  var x = parseFloat(argv[0]), y0 = parseFloat(argv[1]), y1 = parseFloat(argv[2]);
  function post(type, y) {
    var ev = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), 0);
    $.CGEventPost(0, ev);
  }
  post(1, y0);
  $.usleep(40000);
  for (var i = 1; i <= 16; i++) { post(4, y0 + (y1 - y0) * i / 16); $.usleep(20000); }
  $.usleep(40000);
  post(6, y1);
  return 'OK';
}`;

const ascRestore = (proc: string) =>
  `tell application "System Events" to set frontmost of process "${proc.replace(/"/g, '\\"')}" to true`;

export async function swipeUpOnMirror(): Promise<SwipeResult> {
  let prevFront = '';
  try {
    const { stdout: prepOut } = await execFileP('osascript', ['-e', ASC_PREP]);
    const out = prepOut.trim();
    if (out === 'ERR|window-not-found') return { ok: false, reason: 'window-not-found' };
    const m = out.match(/^([^|]+)\|(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/);
    if (!m) return { ok: false, reason: 'inject-failed', detail: 'bad prep output: ' + out.slice(0, 120) };
    prevFront = m[1];
    const bx = +m[2], by = +m[3], bw = +m[4], bh = +m[5];
    await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_SWIPE,
      String(bx + bw / 2), String(by + bh * 5 / 6), String(by + bh / 3)]);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Can.t get process|window-not-found/i.test(msg)) {
      return { ok: false, reason: 'window-not-found', detail: msg.slice(0, 200) };
    }
    return { ok: false, reason: 'inject-failed', detail: msg.slice(0, 200) };
  } finally {
    // 提前过焦点就要恢复(对称);prep 未成功(没抢焦点)时 prevFront 为空跳过
    if (prevFront) {
      try { await execFileP('osascript', ['-e', ascRestore(prevFront)]); } catch { /* 恢复失败不影响注入结果 */ }
    }
  }
}
