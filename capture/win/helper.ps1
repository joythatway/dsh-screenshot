param()
# Windows 采集 helper：常驻一个 PowerShell 进程，Add-Type 只做一次。
# 父进程（capture/windows.js）通过 stdin/stdout 的 JSON 行通信，一行请求一行响应。
#
# 请求：{"id":1,"op":"list"|"screen"|"window"|"thumb"|"region"|"ping","...":...}
# 响应：{"id":1,"ok":true,...} / {"id":1,"ok":false,"error":"...","detail":"..."}
#
# 为什么常驻：powershell.exe 冷启动 + Add-Type 编译 C# 每次要 1.2s 左右，
# 之前每次截图都付一遍，还要再起第二个进程做缩放。常驻之后这些成本只在插件加载时付一次。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies 'System', 'System.Core', 'System.Drawing', 'System.Windows.Forms' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class Shot
{
    public bool ok { get; set; }
    public string error { get; set; }
    public int width { get; set; }
    public int height { get; set; }
    public string data { get; set; }
    public int bytes { get; set; }
    public string kind { get; set; }
}

public class WindowItem
{
    public long id { get; set; }
    public int pid { get; set; }
    public string title { get; set; }
    public string app { get; set; }
    public string cls { get; set; }
    public int x { get; set; }
    public int y { get; set; }
    public int w { get; set; }
    public int h { get; set; }
}

public class PickResult
{
    public bool ok { get; set; }
    public bool cancelled { get; set; }
    public int x { get; set; }
    public int y { get; set; }
    public int w { get; set; }
    public int h { get; set; }
}

public class WindowPickResult
{
    public bool ok { get; set; }
    public bool cancelled { get; set; }
    public long hwnd { get; set; }
}

// 遮罩的超时保险：到点自己取消。两个遮罩共用，避免宿主卡住时把用户困在全屏遮罩里。
public class AutoClose : IDisposable
{
    private readonly Timer timer;

    public AutoClose(int intervalMs, Action expire)
    {
        timer = new Timer();
        timer.Interval = intervalMs;
        timer.Tick += delegate { timer.Stop(); expire(); };
        timer.Start();
    }

    public void Dispose()
    {
        timer.Stop();
        timer.Dispose();
    }
}

public class WinShot
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const long WS_EX_APPWINDOW = 0x00040000L;
    private const long WS_EX_NOACTIVATE = 0x08000000L;
    private const int DWMWA_CLOAKED = 14;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const uint GW_OWNER = 4;
    // 遮罩最多停留 5 分钟：万一宿主崩了 / 卡住没回来，遮罩自己收掉，
    // 调用方的 finally 也会把隐藏的窗口恢复回来，不会把用户困在全屏遮罩里。
    public const int PICKER_MAX_MS = 300000;

    private static readonly HashSet<string> SkipClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
        "ForegroundStaging", "MultitaskingViewFrame", "XamlExplorerHostIslandWindow",
        "TaskListThumbnailWnd", "DV2ControlHost", "Windows.Internal.Shell.TabProxyWindow",
        "Windows.UI.Core.CoreWindow", "Windows.UI.Composition.DesktopWindowContentBridge"
    };

    // 必须最早调用：让所有坐标都是物理像素，否则多屏 / 高 DPI 下截出来的位置会漂。
    public static bool InitDpi()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true;
        }
        catch { }
        try { return SetProcessDPIAware(); } catch { return false; }
    }

    private static bool Intersects(RECT rect, Rectangle area)
    {
        return rect.Right > area.Left && rect.Left < area.Right && rect.Bottom > area.Top && rect.Top < area.Bottom;
    }

    public static List<WindowItem> List()
    {
        List<WindowItem> items = new List<WindowItem>();
        Dictionary<int, string> names = new Dictionary<int, string>();
        Rectangle area = SystemInformation.VirtualScreen;

        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;

            long style = GetWindowLongPtr(hWnd, GWL_EXSTYLE).ToInt64();
            if ((style & WS_EX_TOOLWINDOW) != 0) return true;
            if ((style & WS_EX_NOACTIVATE) != 0) return true;

            int cloaked;
            if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;

            int length = GetWindowTextLength(hWnd);
            if (length <= 0) return true;
            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(hWnd, title, title.Capacity);

            StringBuilder cls = new StringBuilder(256);
            GetClassName(hWnd, cls, cls.Capacity);
            if (SkipClasses.Contains(cls.ToString())) return true;

            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width < 80 || height < 60) return true;
            if (!Intersects(rect, area)) return true;

            IntPtr owner = GetWindow(hWnd, GW_OWNER);
            if (owner != IntPtr.Zero && (style & WS_EX_APPWINDOW) == 0) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string app = "";
            if (!names.TryGetValue((int)pid, out app))
            {
                try { app = Process.GetProcessById((int)pid).ProcessName; }
                catch { app = ""; }
                names[(int)pid] = app;
            }

            WindowItem item = new WindowItem();
            item.id = (long)hWnd;
            item.pid = (int)pid;
            item.title = title.ToString();
            item.app = app;
            item.cls = cls.ToString();
            item.x = rect.Left;
            item.y = rect.Top;
            item.w = width;
            item.h = height;
            items.Add(item);
            return true;
        }, IntPtr.Zero);

        return items;
    }

    public static Bitmap GrabScreen()
    {
        Rectangle area = SystemInformation.VirtualScreen;
        Bitmap bitmap = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.CopyFromScreen(area.X, area.Y, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
        }
        return bitmap;
    }

    private static bool IsFlat(Bitmap bitmap)
    {
        int stepX = Math.Max(1, bitmap.Width / 16);
        int stepY = Math.Max(1, bitmap.Height / 16);
        int min = 255;
        int max = 0;
        double sum = 0;
        double sumSquares = 0;
        int count = 0;
        for (int y = 0; y < bitmap.Height; y += stepY)
        {
            for (int x = 0; x < bitmap.Width; x += stepX)
            {
                Color color = bitmap.GetPixel(x, y);
                int value = Math.Max(color.R, Math.Max(color.G, color.B));
                if (value < min) min = value;
                if (value > max) max = value;
                sum += value;
                sumSquares += (double)value * value;
                count++;
            }
        }
        if (count == 0) return true;
        double mean = sum / count;
        double variance = sumSquares / count - mean * mean;
        return (max - min) < 8 || Math.Sqrt(Math.Max(0, variance)) < 4;
    }

    private static Shot Save(Bitmap bitmap, int maxEdge, string kind)
    {
        int width = bitmap.Width;
        int height = bitmap.Height;
        Bitmap scaled = null;
        Bitmap target = bitmap;
        try
        {
            int longest = Math.Max(width, height);
            if (maxEdge > 0 && longest > maxEdge)
            {
                double ratio = (double)maxEdge / longest;
                int targetWidth = Math.Max(1, (int)Math.Round(width * ratio));
                int targetHeight = Math.Max(1, (int)Math.Round(height * ratio));
                scaled = new Bitmap(targetWidth, targetHeight, PixelFormat.Format32bppArgb);
                using (Graphics graphics = Graphics.FromImage(scaled))
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.SmoothingMode = SmoothingMode.HighQuality;
                    graphics.DrawImage(bitmap, 0, 0, targetWidth, targetHeight);
                }
                width = targetWidth;
                height = targetHeight;
                target = scaled;
            }
            // 直接在内存里编码成 PNG，再以 base64 交回宿主：不落盘，也就没有临时文件垃圾。
            using (MemoryStream stream = new MemoryStream())
            {
                target.Save(stream, ImageFormat.Png);
                byte[] bytes = stream.ToArray();
                Shot shot = new Shot();
                shot.ok = true;
                shot.width = width;
                shot.height = height;
                shot.kind = kind;
                shot.bytes = bytes.Length;
                shot.data = Convert.ToBase64String(bytes);
                return shot;
            }
        }
        finally
        {
            if (scaled != null) scaled.Dispose();
        }
    }

    private static Shot Error(string message)
    {
        Shot shot = new Shot();
        shot.ok = false;
        shot.error = message;
        return shot;
    }

    public static Shot CaptureScreen(int maxEdge)
    {
        using (Bitmap bitmap = GrabScreen())
        {
            return Save(bitmap, maxEdge, "screen");
        }
    }

    public static Shot CaptureWindow(long handle, int maxEdge)
    {
        IntPtr hWnd = new IntPtr(handle);
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) return Error("window_not_found");
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) return Error("window_not_found");

        // Win10/11 的 GetWindowRect 把不可见的缩放边框也算进去，PrintWindow 在这些
        // 区域会留下一条白边；用 DWM 的可见框架范围把它们裁掉。
        int cropX = 0;
        int cropY = 0;
        int cropWidth = width;
        int cropHeight = height;
        try
        {
            RECT visible;
            if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out visible, Marshal.SizeOf(typeof(RECT))) == 0)
            {
                int visibleWidth = visible.Right - visible.Left;
                int visibleHeight = visible.Bottom - visible.Top;
                if (visibleWidth > 0 && visibleHeight > 0)
                {
                    cropX = visible.Left - rect.Left;
                    cropY = visible.Top - rect.Top;
                    cropWidth = visibleWidth;
                    cropHeight = visibleHeight;
                }
            }
        }
        catch { }

        using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            bool painted;
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                IntPtr hdc = graphics.GetHdc();
                try { painted = PrintWindow(hWnd, hdc, 2); }
                finally { graphics.ReleaseHdc(hdc); }
            }
            if (!painted || IsFlat(bitmap))
            {
                try
                {
                    // 回退也按可见范围对齐，否则会把窗口阴影一起截进来。
                    using (Graphics graphics = Graphics.FromImage(bitmap))
                    {
                        graphics.CopyFromScreen(rect.Left + cropX, rect.Top + cropY, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
                    }
                    painted = false;
                }
                catch { return Error("capture_failed"); }
            }

            Rectangle crop = new Rectangle(cropX, cropY, cropWidth, cropHeight);
            crop.Intersect(new Rectangle(0, 0, width, height));
            if (crop.Width <= 0 || crop.Height <= 0 || (crop.X == 0 && crop.Y == 0 && crop.Width == width && crop.Height == height))
            {
                return Save(bitmap, maxEdge, painted ? "printwindow" : "screen");
            }
            using (Bitmap cropped = bitmap.Clone(crop, PixelFormat.Format32bppArgb))
            {
                return Save(cropped, maxEdge, painted ? "printwindow" : "screen");
            }
        }
    }

    public static Shot SaveCrop(Bitmap source, int x, int y, int width, int height, int maxEdge)
    {
        Rectangle rect = new Rectangle(x, y, width, height);
        rect.Intersect(new Rectangle(0, 0, source.Width, source.Height));
        if (rect.Width <= 0 || rect.Height <= 0) return Error("empty_region");
        using (Bitmap crop = source.Clone(rect, PixelFormat.Format32bppArgb))
        {
            return Save(crop, maxEdge, "region");
        }
    }

    public static PickResult Pick(Bitmap background)
    {
        PickResult result = new PickResult();
        using (RegionPicker picker = new RegionPicker(background))
        {
            picker.ShowDialog();
            Rectangle chosen = picker.Selection();
            if (picker.DialogResult == DialogResult.OK && chosen.Width > 0)
            {
                result.ok = true;
                result.x = chosen.X;
                result.y = chosen.Y;
                result.w = chosen.Width;
                result.h = chosen.Height;
            }
            else
            {
                result.cancelled = true;
            }
        }
        return result;
    }

    public static WindowPickResult PickWindow(Bitmap background, List<WindowItem> windows, string hint)
    {
        WindowPickResult result = new WindowPickResult();
        using (WindowPicker picker = new WindowPicker(background, windows, hint))
        {
            picker.ShowDialog();
            long chosen = picker.SelectedWindow();
            if (picker.DialogResult == DialogResult.OK && chosen != 0)
            {
                result.ok = true;
                result.hwnd = chosen;
            }
            else
            {
                result.cancelled = true;
            }
        }
        return result;
    }

    private static IntPtr FindWindowOfPid(int pid)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner != (uint)pid) return true;
            if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            long area = (long)(rect.Right - rect.Left) * (long)(rect.Bottom - rect.Top);
            if (area > bestArea)
            {
                bestArea = area;
                best = hWnd;
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // 宿主的窗口到底长在哪个进程里，取决于 Electron 怎么启动宿主：主进程本身，还是它 fork 出来
    // 的子进程。把候选 pid 依次试一遍、取第一个有可见窗口的，换架构时最多是「不隐藏」，不会隐藏错人。
    public static IntPtr FindMainWindow(int[] pids)
    {
        if (pids == null) return IntPtr.Zero;
        for (int i = 0; i < pids.Length; i++)
        {
            if (pids[i] <= 0) continue;
            IntPtr found = FindWindowOfPid(pids[i]);
            if (found != IntPtr.Zero) return found;
        }
        return IntPtr.Zero;
    }

    public static void HideWindow(IntPtr hWnd) { if (hWnd != IntPtr.Zero) ShowWindow(hWnd, 0); }
    public static bool IsZoomedWindow(IntPtr hWnd) { return hWnd != IntPtr.Zero && IsZoomed(hWnd); }
    public static void RestoreWindow(IntPtr hWnd, bool maximized)
    {
        if (hWnd == IntPtr.Zero) return;
        // 隐藏前是最大化的，恢复时也要按最大化显示，否则窗口会缩成原来的浮动尺寸。
        ShowWindow(hWnd, maximized ? 3 : 5);
        try { SetForegroundWindow(hWnd); } catch { }
    }
}

public class RegionPicker : Form
{
    private readonly Bitmap background;
    private readonly Bitmap dimmed;
    private Rectangle selection = Rectangle.Empty;
    private Point origin;
    private bool dragging;
    private Rectangle chosenRect;
    private readonly AutoClose autoClose;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    public RegionPicker(Bitmap source)
    {
        background = source;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = SystemInformation.VirtualScreen;
        TopMost = true;
        ShowInTaskbar = false;
        Cursor = Cursors.Cross;
        DoubleBuffered = true;
        KeyPreview = true;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.Black;

        dimmed = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(dimmed))
        {
            graphics.DrawImageUnscaled(source, 0, 0);
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(120, 0, 0, 0)))
            {
                graphics.FillRectangle(brush, 0, 0, dimmed.Width, dimmed.Height);
            }
        }
        autoClose = new AutoClose(WinShot.PICKER_MAX_MS, CancelPick);
    }

    private void CancelPick()
    {
        DialogResult = DialogResult.Cancel;
        Close();
    }

    public Rectangle Selection()
    {
        return chosenRect;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && autoClose != null) autoClose.Dispose();
        if (disposing && dimmed != null) dimmed.Dispose();
        base.Dispose(disposing);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // 任务栏也是 TOPMOST，单纯设置 TopMost 会被它压住；显式顶到 topmost 组最前面。
        SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
        Activate();
        Focus();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.DrawImageUnscaled(dimmed, 0, 0);
        if (selection.Width > 0 && selection.Height > 0)
        {
            e.Graphics.DrawImage(background, selection, selection, GraphicsUnit.Pixel);
            using (Pen pen = new Pen(Color.FromArgb(0, 153, 255), 2))
            {
                e.Graphics.DrawRectangle(pen, selection.X, selection.Y, selection.Width - 1, selection.Height - 1);
            }
            string label = selection.Width + " × " + selection.Height;
            using (Font font = new Font("Segoe UI", 11f))
            using (SolidBrush back = new SolidBrush(Color.FromArgb(200, 0, 0, 0)))
            using (SolidBrush fore = new SolidBrush(Color.White))
            {
                SizeF size = e.Graphics.MeasureString(label, font);
                float left = selection.X + 8;
                float top = selection.Y + selection.Height + 8;
                if (top + size.Height + 8 > Height) top = selection.Y - size.Height - 16;
                if (left + size.Width + 12 > Width) left = Width - size.Width - 20;
                e.Graphics.FillRectangle(back, left, top, size.Width + 12, size.Height + 8);
                e.Graphics.DrawString(label, font, fore, left + 6, top + 4);
            }
        }
        base.OnPaint(e);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Right)
        {
            // 右键直接退出框选，和系统截图工具的习惯一致。
            DialogResult = DialogResult.Cancel;
            Close();
            return;
        }
        if (e.Button == MouseButtons.Left)
        {
            origin = e.Location;
            selection = new Rectangle(e.Location, Size.Empty);
            dragging = true;
            Invalidate();
        }
        base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (dragging)
        {
            selection = new Rectangle(
                Math.Min(origin.X, e.X),
                Math.Min(origin.Y, e.Y),
                Math.Abs(e.X - origin.X),
                Math.Abs(e.Y - origin.Y));
            Invalidate();
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left && dragging)
        {
            dragging = false;
            if (selection.Width >= 8 && selection.Height >= 8)
            {
                chosenRect = selection;
                DialogResult = DialogResult.OK;
                Close();
            }
            else
            {
                selection = Rectangle.Empty;
                Invalidate();
            }
        }
        base.OnMouseUp(e);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape)
        {
            DialogResult = DialogResult.Cancel;
            Close();
        }
        base.OnKeyDown(e);
    }
}

public class WindowPicker : Form
{
    private readonly Bitmap background;
    private readonly Bitmap dimmed;
    private readonly List<WindowItem> windows;
    private readonly Rectangle virtualScreen;
    private readonly string hint;
    private int hover = -1;
    private long chosen;
    private readonly AutoClose autoClose;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    public WindowPicker(Bitmap source, List<WindowItem> list, string hintText)
    {
        background = source;
        windows = list;
        hint = hintText;
        virtualScreen = SystemInformation.VirtualScreen;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = virtualScreen;
        TopMost = true;
        ShowInTaskbar = false;
        Cursor = Cursors.Hand;
        DoubleBuffered = true;
        KeyPreview = true;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.Black;

        dimmed = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(dimmed))
        {
            graphics.DrawImageUnscaled(source, 0, 0);
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(120, 0, 0, 0)))
            {
                graphics.FillRectangle(brush, 0, 0, dimmed.Width, dimmed.Height);
            }
        }
        autoClose = new AutoClose(WinShot.PICKER_MAX_MS, CancelPick);
    }

    private void CancelPick()
    {
        DialogResult = DialogResult.Cancel;
        Close();
    }

    public long SelectedWindow() { return chosen; }

    protected override void Dispose(bool disposing)
    {
        if (disposing && autoClose != null) autoClose.Dispose();
        if (disposing && dimmed != null) dimmed.Dispose();
        base.Dispose(disposing);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
        Activate();
        Focus();
    }

    private Rectangle ClientRectOf(WindowItem item)
    {
        return new Rectangle(item.x - virtualScreen.Left, item.y - virtualScreen.Top, item.w, item.h);
    }

    /** 按 z 序找指针下面第一个窗口；列表本来就是最前在前。 */
    private int HitTest(Point screen)
    {
        for (int i = 0; i < windows.Count; i++)
        {
            WindowItem item = windows[i];
            if (screen.X >= item.x && screen.X < item.x + item.w && screen.Y >= item.y && screen.Y < item.y + item.h)
                return i;
        }
        return -1;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        int index = HitTest(PointToScreen(e.Location));
        if (index != hover)
        {
            hover = index;
            Invalidate();
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Right)
        {
            DialogResult = DialogResult.Cancel;
            Close();
            return;
        }
        if (e.Button == MouseButtons.Left && hover >= 0)
        {
            chosen = windows[hover].id;
            DialogResult = DialogResult.OK;
            Close();
            return;
        }
        base.OnMouseDown(e);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape)
        {
            DialogResult = DialogResult.Cancel;
            Close();
        }
        base.OnKeyDown(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.DrawImageUnscaled(dimmed, 0, 0);

        using (Font hintFont = new Font("Segoe UI", 11f))
        using (SolidBrush hintBack = new SolidBrush(Color.FromArgb(200, 0, 0, 0)))
        using (SolidBrush hintFore = new SolidBrush(Color.White))
        {
            SizeF size = e.Graphics.MeasureString(hint, hintFont);
            float left = (Width - size.Width) / 2f;
            e.Graphics.FillRectangle(hintBack, left - 10, 16, size.Width + 20, size.Height + 10);
            e.Graphics.DrawString(hint, hintFont, hintFore, left, 21);
        }

        if (hover >= 0)
        {
            WindowItem item = windows[hover];
            Rectangle rect = ClientRectOf(item);
            rect.Intersect(new Rectangle(0, 0, background.Width, background.Height));
            if (rect.Width > 0 && rect.Height > 0)
            {
                e.Graphics.DrawImage(background, rect, rect, GraphicsUnit.Pixel);
                using (Pen pen = new Pen(Color.FromArgb(0, 153, 255), 2))
                {
                    e.Graphics.DrawRectangle(pen, rect.X, rect.Y, rect.Width - 1, rect.Height - 1);
                }
                string label = item.title;
                if (label.Length > 60) label = label.Substring(0, 60) + "...";
                using (Font font = new Font("Segoe UI", 11f))
                using (SolidBrush back = new SolidBrush(Color.FromArgb(200, 0, 0, 0)))
                using (SolidBrush fore = new SolidBrush(Color.White))
                {
                    SizeF size = e.Graphics.MeasureString(label, font);
                    float left = rect.X + 8;
                    float top = rect.Y + 8;
                    if (top + size.Height + 8 > Height) top = Height - size.Height - 16;
                    if (left + size.Width + 12 > Width) left = Width - size.Width - 20;
                    e.Graphics.FillRectangle(back, left, top, size.Width + 12, size.Height + 8);
                    e.Graphics.DrawString(label, font, fore, left + 6, top + 4);
                }
            }
        }
        base.OnPaint(e);
    }
}
'@

function New-ShotPayload {
    param($shot)
    $payload = @{ ok = $shot.ok; width = $shot.width; height = $shot.height; kind = $shot.kind; bytes = $shot.bytes; data = $shot.data }
    if (-not $shot.ok) { $payload.error = $shot.error }
    return $payload
}

# 宿主主窗口可能是父进程的，也可能是自己的：请求里带一串候选 pid，按顺序取第一个有窗口的。
function Get-ShellPidList {
    param($request)
    [int[]]$pids = @()
    if (-not $request.hideShell) { return $pids }
    if ($request.shellPids) {
        foreach ($item in @($request.shellPids)) {
            $value = [int]$item
            if ($value -gt 0) { $pids += $value }
        }
    } elseif ($request.shellPid) {
        $value = [int]$request.shellPid
        if ($value -gt 0) { $pids += $value }
    }
    return $pids
}

function Invoke-Request {
    param($request)

    switch ($request.op) {
        'ping' {
            return @{ ok = $true; pid = $PID; dpi = [WinShot]::InitDpi() }
        }
        'list' {
            $windows = [WinShot]::List()
            return @{ ok = $true; windows = @($windows) }
        }
        'screen' {
            return New-ShotPayload ([WinShot]::CaptureScreen([int]$request.maxEdge))
        }
        'window' {
            return New-ShotPayload ([WinShot]::CaptureWindow([long]$request.hwnd, [int]$request.maxEdge))
        }
        'thumb' {
            return New-ShotPayload ([WinShot]::CaptureWindow([long]$request.hwnd, [int]$request.edge))
        }
        'pick' {
            $shell = [IntPtr]::Zero
            $zoom = $false
            $shellPids = @(Get-ShellPidList $request)
            if ($shellPids.Count -gt 0) {
                $shell = [WinShot]::FindMainWindow([int[]]$shellPids)
                if ($shell -ne [IntPtr]::Zero) {
                    $zoom = [WinShot]::IsZoomedWindow($shell)
                    [WinShot]::HideWindow($shell)
                    Start-Sleep -Milliseconds 180
                }
            }
            try {
                $background = [WinShot]::GrabScreen()
                try {
                    $windows = [WinShot]::List()
                    $pick = [WinShot]::PickWindow($background, $windows, '点击窗口截图 · 右键或 Esc 取消')
                    if (-not $pick.ok) {
                        return @{ ok = $false; error = 'cancelled' }
                    }
                    return New-ShotPayload ([WinShot]::CaptureWindow([long]$pick.hwnd, [int]$request.maxEdge))
                } finally {
                    $background.Dispose()
                }
            } finally {
                if ($shell -ne [IntPtr]::Zero) { [WinShot]::RestoreWindow($shell, $zoom) }
            }
        }
        'region' {
            $shell = [IntPtr]::Zero
            $zoom = $false
            $shellPids = @(Get-ShellPidList $request)
            if ($shellPids.Count -gt 0) {
                $shell = [WinShot]::FindMainWindow([int[]]$shellPids)
                if ($shell -ne [IntPtr]::Zero) {
                    $zoom = [WinShot]::IsZoomedWindow($shell)
                    [WinShot]::HideWindow($shell)
                    Start-Sleep -Milliseconds 180
                }
            }
            try {
                $background = [WinShot]::GrabScreen()
                try {
                    $pick = [WinShot]::Pick($background)
                    if (-not $pick.ok) {
                        return @{ ok = $false; error = 'cancelled' }
                    }
                    $shot = [WinShot]::SaveCrop($background, $pick.x, $pick.y, $pick.w, $pick.h, [int]$request.maxEdge)
                    $payload = New-ShotPayload $shot
                    $payload.kind = 'region'
                    $payload.rect = @{ x = $pick.x; y = $pick.y; w = $pick.w; h = $pick.h }
                    return $payload
                } finally {
                    $background.Dispose()
                }
            } finally {
                if ($shell -ne [IntPtr]::Zero) { [WinShot]::RestoreWindow($shell, $zoom) }
            }
        }
        default {
            return @{ ok = $false; error = 'unknown_op' }
        }
    }
}

try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }
[WinShot]::InitDpi() | Out-Null

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $request = $null
    $requestId = 0
    try {
        $request = $line | ConvertFrom-Json
        $requestId = $request.id
    } catch {
        [Console]::Out.WriteLine('{"id":0,"ok":false,"error":"bad_request"}')
        [Console]::Out.Flush()
        continue
    }

    try {
        $response = Invoke-Request $request
        if ($null -eq $response) { $response = @{ ok = $false; error = 'empty_response' } }
    } catch {
        $response = @{ ok = $false; error = 'exception'; detail = $_.Exception.Message }
    }

    try {
        $response.id = $requestId
        [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))
        [Console]::Out.Flush()
    } catch {
        break
    }
}
