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
  '    set wx to 0',
  '    set wy to 0',  // 注意:AppleScript 保留字不可用作变量名(by 撞保留字 → 语法错误)
  '    set bw to 0',
  '    set bh to 0',
  '    repeat with w in windows',
  '      set {x, y} to position of w',
  '      set {ww, hh} to size of w',
  '      if ww * hh > maxA then',
  '        set maxA to ww * hh',
  '        set wx to x',
  '        set wy to y',
  '        set bw to ww',
  '        set bh to hh',
  '      end if',
  '    end repeat',
  '  end tell',
  '  if bw < 50 or bh < 50 then return "ERR|window-not-found"',
  `  set frontmost of process "${MIRROR_PROCESS}" to true`,
  '  delay 0.25',
  '  return prevFront & "|" & (wx as text) & "," & (wy as text) & "," & (bw as text) & "," & (bh as text)',
  'end tell',
].join('\n');

// ② JXA:合成滚动事件(触摸板双指上划的等价物——用户实测真实双指滚动可触发 iPhone 上划,
//   而合成拖拽被 Continuity 判成点击)。序列:光标瞬移窗口中心(scroll 派发给光标下窗口)→
//   8×(-60px)滚动 → 光标移回原位。实测约束:窗口必须 frontmost(PostToPid/session tap/
//   可见非前台均无效);瞬移一次无爬行,全程 ~150ms。
//   坐标系:NSEvent.mouseLocation 为 NS 系(原点左下),CG 系(原点左上)翻转以主屏为准
const JXA_SWIPE = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
ObjC.import('unistd');
function run(argv) {
  var x = parseFloat(argv[0]), y = parseFloat(argv[1]);
  var mb = $.CGDisplayBounds($.CGMainDisplayID());
  var orig = $.NSEvent.mouseLocation;
  var ox = orig.x, oy = (mb.origin.y + mb.size.height) - orig.y;
  $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(x, y), 0));
  $.usleep(30000);
  for (var i = 0; i < 8; i++) {
    $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 1, -60));
    $.usleep(12000);
  }
  $.usleep(20000);
  $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(ox, oy), 0));
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
      String(bx + bw / 2), String(by + bh / 2)]);
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
