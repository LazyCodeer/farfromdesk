import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';

import 'bridge_theme.dart';
import 'connection_status.dart';
import 'gateway.dart';
import 'social_platform_logo.dart';

/// An explicitly selected session and a single, fenced dispatch attempt.
class SocialGenerateDialog extends StatefulWidget {
  const SocialGenerateDialog({
    super.key,
    required this.gateway,
    this.initialPrompt = '',
    this.initialImageProvider = 'local',
  });
  final Gateway gateway;
  final String initialPrompt;
  final String initialImageProvider;

  @override
  State<SocialGenerateDialog> createState() => _SocialGenerateDialogState();
}

class _SocialGenerateDialogState extends State<SocialGenerateDialog> {
  final prompt = TextEditingController();
  final custom = TextEditingController();
  final selectedPlatforms = <String>{};
  static const platformIds = {
    'Instagram': 'instagram',
    'LinkedIn': 'linkedin',
    'X': 'x',
    'Facebook': 'facebook',
    'Threads': 'threads',
    'TikTok': 'tiktok',
    'YouTube': 'youtube',
    'Reddit': 'reddit',
    'Other': 'other',
  };
  Map<String, dynamic>? status;
  List<Map<String, dynamic>> sessions = [];
  String? selectedId, loadError, formError, eventId, requestId, responseStatus;
  String imageProvider = 'local';
  bool metaConfigured(Map<String, dynamic>? data) =>
      data?['metaBrain'] is Map &&
      (data!['metaBrain'] as Map)['configured'] == true;
  bool loading = true, posting = false, outcomeUnknown = false;

  @override
  void initState() {
    super.initState();
    prompt.text = widget.initialPrompt;
    imageProvider = widget.initialImageProvider == 'meta' ? 'meta' : 'local';
    refreshSessions();
  }

  @override
  void dispose() {
    prompt.dispose();
    custom.dispose();
    super.dispose();
  }

  List<Map<String, dynamic>> activeSessions(Map<String, dynamic> data) {
    final value = data['bindings'];
    if (value is! List) return [];
    return value
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .where((b) {
          final enabled = b['enabled'] == true || b['enabled'] == 1;
          return enabled &&
              b['id'] is String &&
              (b['id'] as String).isNotEmpty &&
              b['native_id'] is String &&
              (b['native_id'] as String).isNotEmpty &&
              b['provider'] is String &&
              (b['provider'] as String).isNotEmpty;
        })
        .toList();
  }

  String? ownerIdentity(Map<String, dynamic> data) {
    if (data['channelChosen'] != true) return null;
    final channel = data['controlChannel'];
    if (channel != 'telegram' && channel != 'whatsapp') return null;
    final state = data[channel];
    if (state is! Map || state['status'] != 'connected') return null;
    final owner = channel == 'telegram'
        ? state['ownerId']
        : state['phoneNumber'];
    if (owner == null || owner.toString().trim().isEmpty) return null;
    return '$channel:${owner.toString().trim()}';
  }

  Future<void> refreshSessions() async {
    try {
      final data = await widget.gateway.get('/api/status');
      if (!mounted) return;
      setState(() {
        status = data;
        sessions = activeSessions(data);
        // Explicit choice is required even when only one session is available.
        selectedId = null;
        loadError = null;
        loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        loading = false;
        loadError =
            'Could not load sessions. Check your connection and refresh.';
      });
    }
  }

  String sessionLabel(Map<String, dynamic> b) {
    final name = '${b['name'] ?? b['alias'] ?? 'Session'}';
    return '$name · ${providerLabel(b['provider'])} · ${b['native_id']}';
  }

  /// Coding session mark: the bundled logo of the app that ran the session.
  Widget sessionMark(dynamic provider) {
    final brand = providerBrand(provider);
    return Image.asset(
      'assets/logo-$brand.png',
      width: brand == 'muse' ? 22 : 20,
      height: brand == 'muse' ? 22 : 20,
      fit: BoxFit.contain,
    );
  }

  Future<void> submit() async {
    if (posting || outcomeUnknown || responseStatus != null) return;
    final id = selectedId;
    final text = prompt.text.trim();
    final owner = status == null ? null : ownerIdentity(status!);
    if (id == null ||
        text.isEmpty ||
        selectedPlatforms.isEmpty ||
        owner == null ||
        (selectedPlatforms.contains('other') && custom.text.trim().isEmpty)) {
      setState(
        () => formError = 'Choose a session and platform, enter a request, and connect your owner chat.',
      );
      return;
    }
    if (imageProvider == 'meta' && !metaConfigured(status)) {
      setState(
        () => formError = 'The hosted image model is unavailable right now. Choose Local SVG skill.',
      );
      return;
    }
    final matches = sessions.where((b) => b['id'] == id).toList();
    if (matches.length != 1) {
      setState(() => formError = 'Choose an available session.');
      return;
    }
    final selected = matches.single;
    setState(() {
      posting = true;
      formError = null;
    });
    try {
      Map<String, dynamic> current;
      try {
        current = await widget.gateway.get('/api/status');
      } catch (_) {
        if (mounted) {
          setState(
            () => formError = 'Could not verify the session and owner chat. Nothing was sent.',
          );
        }
        return;
      }
      final latest = activeSessions(current)
          .where((b) => b['id'] == id)
          .toList();
      if (ownerIdentity(current) != owner ||
          latest.length != 1 ||
          latest.single['native_id'] != selected['native_id'] ||
          latest.single['provider'] != selected['provider']) {
        if (mounted) {
          setState(
            () => formError = 'The session or owner chat changed. Nothing was sent. Refresh and choose again.',
          );
        }
        return;
      }
      if (imageProvider == 'meta' && !metaConfigured(current)) {
        if (mounted) {
          setState(
            () => formError =
                'The hosted image model is unavailable. Nothing was sent.',
          );
        }
        return;
      }
      final chosen = platformIds.values
          .where(selectedPlatforms.contains)
          .toList();
      // The contract has no custom-name field; include it in the visible request.
      final submittedPrompt = selectedPlatforms.contains('other')
          ? '$text\n\nOther platform: ${custom.text.trim()}'
          : text;
      final attempt = const Uuid().v4();
      eventId = attempt;
      try {
        final result = await widget.gateway.post('/api/social/dispatch', {
          'bindingId': id,
          'prompt': submittedPrompt,
          'platforms': chosen,
          'imageProvider': imageProvider,
          'eventId': attempt,
        });
        if (!mounted) return;
        final resultId = result['requestId'];
        final resultStatus = result['status'];
        if (resultId is! String ||
            resultId.isEmpty ||
            resultStatus is! String ||
            resultStatus.isEmpty) {
          setState(() => outcomeUnknown = true);
          return;
        }
        setState(() {
          requestId = resultId;
          responseStatus = resultStatus;
        });
      } catch (_) {
        if (mounted) setState(() => outcomeUnknown = true);
      }
    } finally {
      if (mounted) setState(() => posting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final owner = status == null ? null : ownerIdentity(status!);
    final done = responseStatus != null || outcomeUnknown;
    final statusText = switch (responseStatus) {
      'queued' => 'Request queued. Follow-up questions and replies go to your paired owner chat.',
      'completed' => 'Request completed. Check Drafts for any saved results.',
      'running' || 'dispatched' || 'submitted' =>
        'Request submitted and in progress. Check your owner chat for updates.',
      'uncertain' => 'The request outcome is uncertain. Check the selected session and owner chat before trying again.',
      'failed' => 'The request failed. Check the selected session and owner chat for details.',
      null => '',
      _ =>
        'Request received with status: $responseStatus. Check the selected session and owner chat.',
    };
    return PopScope(
      canPop: !posting,
      child: AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.auto_awesome_outlined, color: accent, size: 24),
            SizedBox(width: 12),
            Flexible(child: Text('Generate social drafts')),
          ],
        ),
        content: SizedBox(
          width: 600,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (loading)
                  const LinearProgressIndicator()
                else if (loadError != null) ...[
                  Text(loadError!, style: const TextStyle(color: warning)),
                  TextButton(
                    onPressed: posting
                        ? null
                        : () {
                            setState(() {
                              loading = true;
                            });
                            refreshSessions();
                          },
                    child: const Text('Refresh sessions'),
                  ),
                ] else if (done) ...[
                  Text(
                    outcomeUnknown
                        ? 'The submission could not be confirmed. Check the selected session and owner chat before trying again; this request will not be retried automatically.'
                        : statusText,
                  ),
                  if (requestId != null)
                    SelectableText(
                      'Request: $requestId',
                      style: const TextStyle(color: muted, fontSize: 12),
                    ),
                  if (eventId != null)
                    SelectableText(
                      'Attempt: $eventId',
                      style: const TextStyle(color: muted, fontSize: 12),
                    ),
                ] else ...[
                  const Text(
                    'Give your agent an idea. It will tailor the posts for each platform and follow up in your connected chat.',
                    style: TextStyle(color: muted, fontSize: 13, height: 1.5),
                  ),
                  const SizedBox(height: 12),
                  if (owner == null)
                    const Text(
                      'Connect a paired owner chat before sending.',
                      style: TextStyle(color: warning),
                    ),
                  if (sessions.isEmpty)
                    const Text(
                      'No connected sessions are available. Connect a session first.',
                      style: TextStyle(color: warning),
                    )
                  else
                    DropdownButtonFormField<String>(
                      key: const Key('social-session-selector'),
                      initialValue: selectedId,
                      isExpanded: true,
                      hint: const Text('Select a session'),
                      decoration: const InputDecoration(
                        labelText: 'Creative session',
                        prefixIcon: Icon(Icons.forum_outlined, size: 18),
                      ),
                      items: sessions
                          .map(
                            (b) => DropdownMenuItem(
                              value: b['id'] as String,
                              child: Row(
                                children: [
                                  sessionMark(b['provider']),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      sessionLabel(b),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          )
                          .toList(),
                      onChanged: posting
                          ? null
                          : (value) => setState(() => selectedId = value),
                    ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: prompt,
                    enabled: !posting,
                    minLines: 3,
                    maxLines: 5,
                    maxLength: 2000,
                    decoration: const InputDecoration(
                      labelText: 'What would you like to create?',
                      hintText: 'A carousel introducing our cart recovery feature to ecommerce founders…',
                      alignLabelWithHint: true,
                    ),
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<String>(
                    key: const Key('social-image-provider'),
                    initialValue: imageProvider,
                    decoration: const InputDecoration(
                      labelText: 'Image generation',
                      prefixIcon: Icon(Icons.image_outlined, size: 18),
                    ),
                    items: const [
                      DropdownMenuItem(
                        value: 'local',
                        child: Text('Local SVG skill'),
                      ),
                      DropdownMenuItem(value: 'meta', child: Text('FarFromDesk hosted')),
                    ],
                    onChanged: posting
                        ? null
                        : (value) => setState(() {
                            imageProvider = value ?? 'local';
                            formError = null;
                          }),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    imageProvider == 'local'
                        ? 'Branded illustrations and carousels rendered locally. No image API key needed. Your selected session still uses its normal plan.'
                        : metaConfigured(status)
                        ? 'Artwork comes from the image model FarFromDesk hosts. Text and logos are composed locally.'
                        : 'The hosted image model is unavailable right now. Choose Local SVG skill.',
                    key: const Key('social-image-provider-help'),
                    style: TextStyle(
                      color: imageProvider == 'meta' && !metaConfigured(status)
                          ? warning
                          : muted,
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'Choose platforms',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final entry in platformIds.entries)
                        FilterChip(
                          avatar: SocialPlatformLogo(entry.value, size: 18),
                          showCheckmark: false,
                          backgroundColor: raised,
                          selectedColor: accentWash,
                          side: BorderSide(
                            color: selectedPlatforms.contains(entry.value)
                                ? accent
                                : line,
                          ),
                          shape: const StadiumBorder(),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 8,
                          ),
                          label: Text(entry.key),
                          selected: selectedPlatforms.contains(entry.value),
                          onSelected: posting
                              ? null
                              : (selected) => setState(() {
                                  if (selected) {
                                    selectedPlatforms.add(entry.value);
                                  } else {
                                    selectedPlatforms.remove(entry.value);
                                  }
                                }),
                        ),
                    ],
                  ),
                  if (selectedPlatforms.contains('other'))
                    TextField(
                      controller: custom,
                      enabled: !posting,
                      maxLength: 100,
                      decoration: const InputDecoration(
                        labelText: 'Other platform name',
                      ),
                    ),
                  const SizedBox(height: 8),
                  const Text(
                    'The selected session may use its configured research and AI tools. Review your provider settings and pricing.',
                    style: TextStyle(color: muted, fontSize: 12),
                  ),
                  if (formError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: Text(
                        formError!,
                        style: const TextStyle(color: warning),
                      ),
                    ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: posting
                ? null
                : () => Navigator.pop(context, responseStatus == 'completed'),
            child: Text(done ? 'Done' : 'Cancel'),
          ),
          if (!done)
            FilledButton(
              onPressed: loading || posting || owner == null || sessions.isEmpty
                  ? null
                  : submit,
              child: Text(posting ? 'Sending…' : 'Send to session'),
            ),
        ],
      ),
    );
  }
}
