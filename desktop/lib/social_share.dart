import 'dart:typed_data';

/// Manual handoff only. Fixed destinations cannot be supplied by draft content.
const socialSharePlatforms = [
  'Instagram',
  'LinkedIn',
  'X',
  'Facebook',
  'Threads',
  'TikTok',
  'YouTube',
  'Reddit',
  'WhatsApp',
  'Other',
];

class SocialSharePayload {
  SocialSharePayload({required this.caption, required this.images});
  final String caption;

  /// All validated JPEG slides, in original order (not only the visible slide).
  final List<Uint8List> images;
}

class SocialShareTarget {
  const SocialShareTarget(this.uri, this.prefillsText);
  final Uri uri;
  final bool prefillsText;
}

SocialShareTarget socialShareTarget(String platform, String caption) {
  // Keep long captions out of browser URLs. Clipboard retains the full text.
  Uri intent(String host, String path) =>
      Uri.https(host, path, {'text': caption});
  if (platform == 'X') {
    final uri = intent('twitter.com', '/intent/tweet');
    return uri.toString().length <= 1800
        ? SocialShareTarget(uri, true)
        : SocialShareTarget(Uri.https('x.com', '/compose/post'), false);
  }
  if (platform == 'WhatsApp') {
    final uri = intent('wa.me', '/');
    return uri.toString().length <= 1800
        ? SocialShareTarget(uri, true)
        : SocialShareTarget(Uri.https('web.whatsapp.com', '/'), false);
  }
  final hosts = {
    'Instagram': 'www.instagram.com',
    'LinkedIn': 'www.linkedin.com',
    'Facebook': 'www.facebook.com',
    'Threads': 'www.threads.com',
    'TikTok': 'www.tiktok.com',
    'YouTube': 'studio.youtube.com',
    'Reddit': 'www.reddit.com',
  };
  final host = hosts[platform];
  if (host == null) throw ArgumentError('Choose a supported destination.');
  return SocialShareTarget(Uri.https(host, '/'), false);
}
