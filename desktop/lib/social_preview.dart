import 'package:flutter/material.dart';

import 'social_workspace.dart';

/// An offline, empty presentation. It never submits an agent request.
class SocialPreview extends StatelessWidget {
  const SocialPreview({super.key});

  @override
  Widget build(BuildContext context) => const KeyedSubtree(
    key: Key('social-preview'),
    child: SocialWorkspace(drafts: []),
  );
}
