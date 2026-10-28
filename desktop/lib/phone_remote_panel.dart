import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';

class PhoneRemotePage extends StatefulWidget {
  final Gateway gateway;
  const PhoneRemotePage({super.key, required this.gateway});
  @override
  State<PhoneRemotePage> createState() => _PhoneRemotePageState();
}

class _PhoneRemotePageState extends State<PhoneRemotePage> {
  final password = TextEditingController();
  final confirmation = TextEditingController();
  Map<String, dynamic> status = {}, permissions = {};
  List<dynamic> apps = [], windows = [];
  int? pid, windowId;
  String? address, error;
  bool busy = false;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    unawaited(refresh());
    timer = Timer.periodic(const Duration(seconds: 3), (_) {
      if (!busy) unawaited(refresh());
    });
  }

  static const _readError = 'Could not read phone access status.';
  // The Mac's error codes in words; anything else keeps the general hint.
  static const _errors = {
    'USE_12_TO_256_CHARACTER_PASSWORD': 'Use a password of 12 to 256 characters.',
    'WAIT_BEFORE_RETRY': 'Too many tries. Wait a moment, then try again.',
    'MAC_ONLY': 'Phone access is available on a Mac only.',
  };
  String explain(Object e) =>
      _errors.entries.where((c) => '$e'.contains(c.key)).map((c) => c.value).firstOrNull ??
      'Could not complete this step. Check permissions and the selected window.';

  Future<void> refresh() async {
    try {
      final next = await widget.gateway.get('/api/phone-remote');
      if (!mounted) return;
      setState(() {
        if (error == _readError) error = null;
        status = next;
        final addresses = next['addresses'] as List? ?? [];
        if (addresses.length == 1) address ??= addresses.first['address'];
      });
    } catch (_) {
      if (mounted) setState(() => error = _readError);
    }
  }

  Future<void> run(Future<void> Function() action) async {
    if (busy) return;
    setState(() { busy = true; error = null; });
    try {
      await action();
      await refresh();
    } catch (e) {
      if (mounted) setState(() => error = explain(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<Map<String, dynamic>> command(Map<String, dynamic> data) =>
      widget.gateway.post('/api/phone-remote', data);

  Future<void> stop() async {
    try {
      await command({'action': 'stop'});
      await refresh();
    } catch (_) {
      if (mounted) setState(() => error = 'Stop could not be confirmed. Disconnect the phone and retry Stop on this Mac.');
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    password.dispose();
    confirmation.dispose();
    // The backend owns the session. Navigating away does not silently stop it.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final running = status['running'] == true;
    final addresses = status['addresses'] as List? ?? [];
    final allowed = permissions['accessibility'] == true && permissions['screen_recording'] == true;
    return Scaffold(
      appBar: AppBar(title: const Text('Phone access to your Mac')),
      body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 720),
        child: ListView(padding: const EdgeInsets.all(24), children: [
          Text(running ? 'Your selected window is available' : 'Try your Mac from your phone', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          const Text('Same Wi-Fi preview. See a selected window, click and insert text. Images refresh after your actions; smooth video, drag and keyboard shortcuts are not available yet.'),
          const SizedBox(height: 20),
          if (status['supported'] == false) const Text('Phone control is currently available for Mac only.'),
          if (error != null) Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          if (status['error'] != null) Text('Could not start: ${status['error']}'),
          if (!running) ...[
            Text(status['passwordSet'] == true ? 'Password saved' : 'Set a remote access password', style: Theme.of(context).textTheme.titleMedium),
            const Text('Use a separate password of at least 12 characters. Do not use your Mac login password.'),
            const SizedBox(height: 12),
            TextField(key: const Key('phone-password'), controller: password, obscureText: true, decoration: const InputDecoration(labelText: 'Remote access password')),
            const SizedBox(height: 12),
            TextField(key: const Key('phone-confirmation'), controller: confirmation, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm password')),
            const SizedBox(height: 12),
            Align(alignment: Alignment.centerLeft, child: OutlinedButton(onPressed: busy ? null : () => run(() async {
              if (password.text.length < 12 || password.text.length > 256 || password.text != confirmation.text) {
                setState(() => error = 'Enter matching passwords of 12 to 256 characters.'); return;
              }
              await command({'action': 'password', 'password': password.text});
              password.clear(); confirmation.clear();
            }), child: const Text('Save password'))),
            const Divider(height: 32),
            Row(children: [Expanded(child: Text('Mac permissions', style: Theme.of(context).textTheme.titleMedium)),
              IconButton(tooltip: 'Check permissions', onPressed: busy ? null : () => run(() async {
                final result = await command({'action': 'check'});
                if (mounted) setState(() => permissions = Map<String, dynamic>.from(result['permissions'] ?? {}));
              }), icon: const Icon(Icons.refresh)),
            ]),
            Text('Accessibility: ${permissions['accessibility'] == true ? 'Allowed' : 'Not confirmed'}'),
            Text('Screen Recording: ${permissions['screen_recording'] == true ? 'Allowed' : 'Not confirmed'}'),
            const Text('Grant permissions to the app named by macOS, then check again. Permission prompts must be answered on your Mac.'),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: busy || !allowed ? null : () => run(() async {
              final result = await command({'action': 'apps'});
              if (mounted) setState(() { apps = result['apps'] ?? []; pid = null; windowId = null; windows = []; });
            }), child: const Text('Find open apps')),
            DropdownButtonFormField<int>(initialValue: pid, decoration: const InputDecoration(labelText: 'App'),
              items: apps.map((a) => DropdownMenuItem<int>(value: a['pid'], child: Text(a['name'].toString()))).toList(),
              onChanged: busy ? null : (value) => run(() async {
                setState(() {pid = value; windowId = null; windows = [];});
                final result = await command({'action': 'windows', 'pid': value});
                if (mounted) setState(() => windows = result['windows'] ?? []);
              })),
            const SizedBox(height: 12),
            DropdownButtonFormField<int>(key: ValueKey(pid), initialValue: windowId, decoration: const InputDecoration(labelText: 'Window'),
              items: windows.map((w) => DropdownMenuItem<int>(value: w['id'], child: Text('${w['title']} (${w['id']})', overflow: TextOverflow.ellipsis))).toList(),
              onChanged: busy ? null : (value) => setState(() => windowId = value)),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(initialValue: address, decoration: const InputDecoration(labelText: 'Local network'),
              items: addresses.map((a) => DropdownMenuItem<String>(value: a['address'], child: Text('${a['name']} · ${a['address']}'))).toList(),
              onChanged: busy ? null : (value) => setState(() => address = value)),
            const SizedBox(height: 20),
            FilledButton(onPressed: busy || !allowed || status['passwordSet'] != true || windowId == null || address == null ? null : () => run(() async {
              await command({'action': 'start', 'pid': pid, 'windowId': windowId, 'address': address});
            }), child: const Text('Start phone preview')),
          ],
          if (running) ...[
            Text(status['connected'] == true ? 'Phone connected' : 'Waiting for your phone', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            const Text('Open this address on your phone, then enter your remote access password.'),
            SelectableText(status['url']?.toString() ?? ''),
            Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => Clipboard.setData(ClipboardData(text: status['url'].toString())), icon: const Icon(Icons.copy), label: const Text('Copy address'))),
            const Text('This local test uses a temporary certificate, so your phone may show a certificate warning. Compare its SHA-256 fingerprint with the one below before allowing this connection. No certificate or permission is installed automatically.'),
            const SizedBox(height: 8),
            SelectableText(status['fingerprint']?.toString() ?? ''),
            const SizedBox(height: 16),
            const Text('Keep the Mac awake and unlocked. Closing this page keeps access running. Stop ends access immediately; start again from the Mac to reconnect.'),
          ],
          const SizedBox(height: 16),
          OutlinedButton.icon(onPressed: stop, icon: const Icon(Icons.stop_circle_outlined), label: const Text('Stop phone access')),
        ]),
      )),
    );
  }
}
