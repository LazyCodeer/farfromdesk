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
  String provider = 'local';
  bool loading = true, saving = false;
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
      });
      if (mounted) Navigator.pop(context, result);
    } catch (_) {
      if (mounted) {
        setState(() {
          saving = false;
          error = 'Could not save. Check your connection, then try again.';
        });
      }
    }
  }

  @override
  void dispose() {
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
                  DropdownMenuItem(value: 'meta', child: Text('FarFromDesk hosted')),
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
                    : 'Artwork is made by the image model FarFromDesk hosts. No key needed. Your session composes the text and logos.',
                style: const TextStyle(color: muted),
              ),
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
            loading || saving
            ? null
            : save,
        child: Text(saving ? 'Saving…' : 'Save'),
      ),
    ],
  );
}
