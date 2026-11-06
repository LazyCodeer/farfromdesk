# Local email send approval for Windows (the counterpart of local-mail-approval.swift).
#
# The backend runs this once per send with the exact draft on stdin as UTF-8 JSON
# {"from","to","subject","body"} and gets {"approved":true} only when the person at the PC
# presses "Send email" in this window. Closing the window, Cancel, Esc or Enter all answer
# {"approved":false}: the default button is Cancel, so a stray Enter can never send.
# Nothing in the request can approve by itself; there is no argument, variable or field
# that skips the dialog.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class FFDMailApproval {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);

  static string Field(Dictionary<string, object> value, string name) {
    object raw; if (!value.TryGetValue(name, out raw)) return null; return raw as string;
  }
  static string Lines(string text) { return text.Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", "\r\n"); }

  public static int Run() {
    byte[] input;
    using (MemoryStream buffer = new MemoryStream()) {
      Stream stdin = Console.OpenStandardInput(); byte[] chunk = new byte[65536]; int read;
      while ((read = stdin.Read(chunk, 0, chunk.Length)) > 0) { buffer.Write(chunk, 0, read); if (buffer.Length > 400000) return 1; }
      input = buffer.ToArray();
    }
    Dictionary<string, object> value;
    try {
      JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = 400000;
      value = json.DeserializeObject(new UTF8Encoding(false, true).GetString(input)) as Dictionary<string, object>;
    } catch { return 1; }
    if (value == null) return 1;
    string from = Field(value, "from"), to = Field(value, "to"), subject = Field(value, "subject"), body = Field(value, "body");
    if (from == null || to == null || subject == null || body == null) return 1;

    try { SetProcessDPIAware(); } catch { }
    Application.EnableVisualStyles();
    Form form = new Form();
    form.Text = "FarFromDesk";
    form.AutoScaleDimensions = new SizeF(96f, 96f);
    form.AutoScaleMode = AutoScaleMode.Dpi;
    form.Font = new Font("Segoe UI", 9.75f);
    form.FormBorderStyle = FormBorderStyle.FixedDialog;
    form.MaximizeBox = false; form.MinimizeBox = false;
    form.StartPosition = FormStartPosition.CenterScreen;
    form.ShowInTaskbar = true; form.TopMost = true;
    form.ClientSize = new Size(600, 480);
    form.Padding = new Padding(16, 12, 16, 12);

    // A table lays the window out from its content, so it stays readable at any display scale.
    TableLayoutPanel layout = new TableLayoutPanel();
    layout.Dock = DockStyle.Fill; layout.ColumnCount = 1; layout.RowCount = 4;
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
    layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
    layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    Label title = new Label();
    title.Text = "Approve this email?"; title.AutoSize = true;
    title.Font = new Font("Segoe UI", 12f, FontStyle.Bold);
    title.Margin = new Padding(0, 0, 0, 4);
    Label detail = new Label();
    detail.Text = "Review the exact recipients, subject and message. Sending cannot be undone.";
    detail.AutoSize = true; detail.MaximumSize = new Size(560, 0); detail.Margin = new Padding(0, 0, 0, 8);
    TextBox text = new TextBox();
    text.Multiline = true; text.ReadOnly = true; text.ScrollBars = ScrollBars.Vertical; text.WordWrap = true;
    text.BackColor = SystemColors.Window; text.TabStop = false; text.Dock = DockStyle.Fill;
    text.Text = Lines("From: " + from + "\nTo: " + to + "\nSubject: " + subject + "\n\n" + body);
    FlowLayoutPanel buttons = new FlowLayoutPanel();
    buttons.FlowDirection = FlowDirection.RightToLeft; buttons.AutoSize = true; buttons.Dock = DockStyle.Fill;
    buttons.Margin = new Padding(0, 10, 0, 0);
    Button cancel = new Button(); cancel.Text = "Cancel"; cancel.AutoSize = true; cancel.Padding = new Padding(10, 3, 10, 3);
    Button send = new Button(); send.Text = "Send email"; send.AutoSize = true; send.Padding = new Padding(10, 3, 10, 3);
    buttons.Controls.Add(cancel); buttons.Controls.Add(send);
    layout.Controls.Add(title, 0, 0); layout.Controls.Add(detail, 0, 1); layout.Controls.Add(text, 0, 2); layout.Controls.Add(buttons, 0, 3);
    bool approved = false;
    send.Click += delegate { approved = true; form.Close(); };
    cancel.Click += delegate { approved = false; form.Close(); };
    form.AcceptButton = cancel; form.CancelButton = cancel;
    form.Controls.Add(layout);
    form.Load += delegate {
      // The backend starts this hidden (no console flash). Windows turns the first "show"
      // call of such a process into "hide", so spend that call here; the form's own show
      // that follows is then honoured.
      ShowWindow(form.Handle, 1);
    };
    form.Shown += delegate { cancel.Focus(); form.Activate(); SetForegroundWindow(form.Handle); };
    Application.Run(form);
    byte[] answer = Encoding.ASCII.GetBytes(approved ? "{\"approved\":true}" : "{\"approved\":false}");
    Stream stdout = Console.OpenStandardOutput(); stdout.Write(answer, 0, answer.Length); stdout.Flush();
    return 0;
  }
}
'@
exit [FFDMailApproval]::Run()
