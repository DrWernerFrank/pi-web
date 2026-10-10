// PiWebHost: pi-web as a native app window.
//
// The page runs in WebView2 — the same engine Tauri uses, shipped with
// Windows — instead of your browsing browser: no profile, no extensions, no
// tabs, no other windows. What RAM it uses is pi-web's and only pi-web's.
//
// Build (host\build.ps1) with the compiler Windows already carries
// (csc from .NET Framework 4.x) — no SDK, no Rust, no installs needed.
// The WebView2 DLLs come from host\get-webview2.ps1 (one-time download).

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class PiWebHost
{
	[DllImport("user32.dll")]
	static extern bool SetProcessDPIAware();

	static void Log(string msg)
	{
		try
		{
			string dir = Path.Combine(
				Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "pi-web");
			Directory.CreateDirectory(dir);
			File.AppendAllText(Path.Combine(dir, "host.log"),
				string.Format("[{0:yyyy-MM-dd HH:mm:ss}] {1}{2}", DateTime.Now, msg, Environment.NewLine));
		}
		catch { }
	}

	[STAThread]
	static void Main(string[] args)
	{
		Log("starting");
		string url = args.Length > 0 ? args[0] : "http://localhost:3141/";
		try { SetProcessDPIAware(); } catch { }
		Application.EnableVisualStyles();
		Application.SetCompatibleTextRenderingDefault(false);

		Form form = new Form();
		form.Text = "pi";
		form.Width = 1440;
		form.Height = 960;
		form.StartPosition = FormStartPosition.CenterScreen;
		form.MinimumSize = new System.Drawing.Size(480, 360);
		string root = AppDomain.CurrentDomain.BaseDirectory;
		string up = Path.GetFullPath(Path.Combine(root, ".."));
		try { form.Icon = new System.Drawing.Icon(Path.Combine(up, "pi-web.ico")); } catch { }

		WebView2 web = new WebView2();
		web.Dock = DockStyle.Fill;
		web.CoreWebView2InitializationCompleted += delegate(object s, CoreWebView2InitializationCompletedEventArgs e)
		{
			Log("init " + (e.IsSuccess ? "ok" : "FAILED: " + e.InitializationException));
		};
		// Its own isolated data folder — never your browser's profile, never
		// synced, nothing to clean up on exit but this one folder.
		CoreWebView2CreationProperties props = new CoreWebView2CreationProperties();
		props.UserDataFolder = Path.Combine(
			Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
			"pi-web", "webview");
		web.CreationProperties = props;
		web.Source = new Uri(url); // navigates as soon as the control initializes
		form.Controls.Add(web);
		Log("window shown, navigating to " + url);

		Application.Run(form);
		Log("exit");
	}
}
