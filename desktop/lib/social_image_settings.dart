import 'dart:io' show Platform;

import 'package:flutter/material.dart';

import 'bridge_theme.dart';
import 'gateway.dart';

/// Configure future requests. Never receives or displays an existing key.
class SocialImageSettings extends StatefulWidget {
  const SocialImageSettings({super.key, required this.gateway});
  final Gateway gateway;
  @override
  State<SocialImageSettings> createState() => _SocialImageSettingsState();
}

class _SocialImageSettingsState extends State<SocialImageSettings> {
  final keyInput = TextEditingController();
  String provider = 'local';
  bool loading = true, saving = false, configured = false;
  String? error;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final data = await widget.gateway.get('/api/social/settings');
      if (!mounted) return;
      setState(() {
        provider = data['imageProvider'] == 'meta' ? 'meta' : 'local';
        configured = data['metaConfigured'] == true;
        loading = false;
        error = null;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          loading = false;
          error = 'Could not check image settings. Please retry.';
        });
      }
    }
  }

  Future<void> save() async {
    setState(() {
      saving = true;
      error = null;
    });
    try {
      final result = await widget.gateway.post('/api/social/settings', {
        'imageProvider': provider,
        if (provider == 'meta' && keyInput.text.trim().isNotEmpty)
          'key': keyInput.text.trim(),
      });
      keyInput.clear();
      if (mounted) Navigator.pop(context, result);
    } catch (_) {
      if (mounted) {
        setState(() {
          saving = false;
          error = 'Could not save. Check your connection and Meta key, then try again.';
        });
      }
    }
  }

  @override
  void dispose() {
    keyInput.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Image generation'),
    content: SizedBox(
      width: 460,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Choose the default for new Social requests. Existing drafts and active requests keep their original source.',
              style: TextStyle(color: muted),
            ),
            const SizedBox(height: 18),
            if (loading)
              const LinearProgressIndicator()
            else ...[
              DropdownButtonFormField<String>(
                key: const Key('social-default-image-provider'),
                initialValue: provider,
                decoration: const InputDecoration(labelText: 'Image source'),
                items: const [
                  DropdownMenuItem(
                    value: 'local',
                    child: Text('Local SVG skill'),
                  ),
                  DropdownMenuItem(value: 'meta', child: Text('Meta API')),
                ],
                onChanged: saving
                    ? null
                    : (v) => setState(() {
                        provider = v ?? 'local';
                        error = null;
                      }),
              ),
              const SizedBox(height: 12),
              Text(
                provider == 'local'
                    ? 'Uses your Claude, Codex or Muse Code session and the bundled illustration skill. No image API key. Your session plan still applies.'
                    : configured
                    ? 'Meta key saved. Provider availability is checked when generating. Your session composes the text and logos.'
                    : 'Add your Meta Model API key below to generate artwork. Your session composes the text and logos.',
                style: const TextStyle(color: muted),
              ),
              if (provider == 'meta') ...[
                const SizedBox(height: 14),
                TextField(
                  key: const Key('social-meta-key'),
                  controller: keyInput,
                  obscureText: true,
                  enableSuggestions: false,
                  autocorrect: false,
                  enabled: !saving,
                  decoration: InputDecoration(
                    labelText: configured
                        ? 'Replace Meta key (optional)'
                        : 'Meta API key',
                  ),
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(height: 8),
                Text(
                  'Shared with Brain settings and saved on this ${Platform.isMacOS ? 'Mac' : Platform.isWindows ? 'PC' : 'computer'}. Never sent to the coding session. Meta usage may be billed.',
                  style: TextStyle(color: muted, fontSize: 12),
                ),
              ],
            ],
            if (error != null) ...[
              const SizedBox(height: 12),
              Text(error!, style: const TextStyle(color: warning)),
              TextButton(
                onPressed: saving ? null : load,
                child: const Text('Retry connection'),
              ),
            ],
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: saving ? null : () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        key: const Key('social-save-image-settings'),
        onPressed:
            loading ||
                saving ||
                (provider == 'meta' &&
                    !configured &&
                    keyInput.text.trim().isEmpty)
            ? null
            : save,
        child: Text(saving ? 'Saving…' : 'Save'),
      ),
    ],
  );
}
