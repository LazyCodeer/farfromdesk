import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'gateway.dart';
import 'social_share.dart';
import 'social_platform_logo.dart';

class SocialShareDialog extends StatefulWidget {
  const SocialShareDialog({
    super.key,
    required this.gateway,
    required this.post,
    required this.initialPlatform,
  });
  final Gateway gateway;
  final SocialSharePayload post;
  final String initialPlatform;
  @override
  State<SocialShareDialog> createState() => _SocialShareDialogState();
}

class _SocialShareDialogState extends State<SocialShareDialog> {
  late String platform = socialSharePlatforms.contains(widget.initialPlatform)
      ? widget.initialPlatform
      : 'Other';
  bool busy = false;
  String? status;
  Future<void> action(Future<String> Function() body) async {
    setState(() {
      busy = true;
      status = null;
    });
    try {
      final message = await body();
      if (mounted) setState(() => status = message);
    } catch (_) {
      if (mounted) {
        setState(
          () => status = 'Could not complete this action. Try again, or export the post and open the platform yourself.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final target = platform == 'Other'
        ? null
        : socialShareTarget(platform, widget.post.caption);
    final imageCount = widget.post.images.length;
    return PopScope(
      canPop: !busy,
      child: AlertDialog(
        title: const Text('Share your post'),
        content: SizedBox(
          width: 460,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: platform,
                  decoration: const InputDecoration(labelText: 'Destination'),
                  items: [
                    for (final name in socialSharePlatforms)
                      DropdownMenuItem(
                        value: name,
                        child: Row(
                          children: [
                            SocialPlatformLogo(name, size: 18),
                            const SizedBox(width: 10),
                            Text(name),
                          ],
                        ),
                      ),
                  ],
                  onChanged: busy
                      ? null
                      : (value) => setState(() {
                          platform = value!;
                          status = null;
                        }),
                ),
                const SizedBox(height: 16),
                Text(
                  '$imageCount image${imageCount == 1 ? '' : 's'} • Full caption'
                  '${imageCount > 1 ? ' • All slides in order' : ''}',
                ),
                const SizedBox(height: 12),
                Text(
                  target?.prefillsText == true
                      ? 'Open copies your caption and prefills the platform’s text field. Images are not attached by the link. Export them first, then attach them yourself.'
                      : 'Open copies your caption and opens the platform. Paste it into a new post and upload your exported images. This platform has no supported full-post autofill here.',
                ),
                if (platform == 'YouTube' || platform == 'TikTok') ...[
                  const SizedBox(height: 8),
                  const Text(
                    'This draft contains images/text, not a rendered video. Use a supported photo post or create a video separately.',
                  ),
                ],
                const SizedBox(height: 12),
                const Text(
                  'You review and press Send or Post in the destination. Nothing is published automatically.',
                ),
                const SizedBox(height: 16),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      key: const Key('social-export-post'),
                      onPressed: busy
                          ? null
                          : () => action(() async {
                              final saved = await widget.gateway
                                  .exportSocialPost(widget.post);
                              return saved
                                  ? 'Exported a new folder with caption.txt and all images.'
                                  : 'Export cancelled. No files were saved.';
                            }),
                      icon: const Icon(Icons.download_outlined),
                      label: const Text('Export complete post'),
                    ),
                    if (widget.gateway.canShareSocialNatively)
                      OutlinedButton.icon(
                        key: const Key('social-native-share'),
                        onPressed: busy
                            ? null
                            : () => action(() async {
                                final opened = await widget.gateway
                                    .shareSocialPost(widget.post);
                                return opened
                                    ? 'Share sheet opened. Available apps decide which text and images they accept; check the destination before sending.'
                                    : 'Share sheet unavailable. Export the post instead.';
                              }),
                        icon: const Icon(Icons.ios_share),
                        label: const Text('macOS share sheet'),
                      ),
                    if (target != null)
                      FilledButton.icon(
                        key: const Key('social-open-platform'),
                        onPressed: busy
                            ? null
                            : () => action(() async {
                                await Clipboard.setData(
                                  ClipboardData(text: widget.post.caption),
                                );
                                await widget.gateway.openSocialPlatform(
                                  platform,
                                  widget.post.caption,
                                );
                                return 'Caption copied. Browser opening requested for $platform. Attach media and review there; no post was sent.';
                              }),
                        icon: const Icon(Icons.open_in_new),
                        label: Text('Copy & open $platform'),
                      ),
                    if (target == null)
                      FilledButton(
                        onPressed: busy
                            ? null
                            : () => action(() async {
                                await Clipboard.setData(
                                  ClipboardData(text: widget.post.caption),
                                );
                                return 'Caption copied. Paste it in your chosen app.';
                              }),
                        child: const Text('Copy caption'),
                      ),
                  ],
                ),
                if (status != null) ...[
                  const SizedBox(height: 16),
                  Text(status!, key: const Key('social-share-status')),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: busy ? null : () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }
}
