import 'package:flutter/material.dart';

import 'bridge_theme.dart';

/// Bundled brand paths, rendered in platform colours. No network image loads.
class SocialPlatformLogo extends StatelessWidget {
  const SocialPlatformLogo(this.platform, {super.key, this.size = 20});
  final String platform;
  final double size;
  @override
  Widget build(BuildContext context) {
    final name = platform.trim().toLowerCase();
    final known = const [
      'instagram',
      'linkedin',
      'x',
      'facebook',
      'threads',
      'tiktok',
      'youtube',
      'reddit',
    ].contains(name);
    return ExcludeSemantics(
      child: SizedBox(
        width: size,
        height: size,
        child: name == 'whatsapp'
            ? Image.asset('assets/logo-whatsapp.png', fit: BoxFit.contain)
            : known
            ? Image.asset('assets/social/logo-$name.png', fit: BoxFit.contain)
            : Icon(Icons.public_outlined, size: size, color: ink2),
      ),
    );
  }
}
