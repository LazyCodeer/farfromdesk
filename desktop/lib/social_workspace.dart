import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'bridge_theme.dart';
import 'social_platform_logo.dart';

/// Presentation for local Social. Data and agent submission are supplied by the
/// host; absent capabilities are shown as unavailable instead of simulated.
enum SocialDraftAction { share, copy, export, delete }

class SocialWorkspace extends StatefulWidget {
  const SocialWorkspace({
    super.key,
    required this.drafts,
    this.selectedDraft,
    this.imageBytes,
    this.slideCount = 0,
    this.slideImages = const [],
    this.selectedSlide = 0,
    this.onSelectSlide,
    this.error,
    this.busy = false,
    this.hasMore = false,
    this.onLoadMore,
    this.onSelectDraft,
    this.onDraftAction,
    this.onCopy,
    this.onShare,
    this.onExportImage,
    this.onDelete,
    this.onGenerate,
    this.onRecover,
    this.onAcknowledge,
    this.imageInvalid = false,
    this.imageProvider = 'local',
    this.metaConfigured,
    this.onChangeImageProvider,
  });

  final String imageProvider;
  final bool? metaConfigured;
  final VoidCallback? onChangeImageProvider;
  final List<dynamic> drafts;
  final Map<String, dynamic>? selectedDraft;
  final Uint8List? imageBytes;
  final int slideCount, selectedSlide;
  final List<Uint8List> slideImages;
  final ValueChanged<int>? onSelectSlide;
  final String? error;
  final bool busy, hasMore, imageInvalid;
  final VoidCallback? onLoadMore,
      onCopy,
      onShare,
      onExportImage,
      onDelete,
      onRecover,
      onAcknowledge;
  final ValueChanged<String>? onSelectDraft;
  final Future<void> Function(String id, SocialDraftAction action)?
  onDraftAction;
  final Future<void> Function(String initialPrompt)? onGenerate;

  @override
  State<SocialWorkspace> createState() => _SocialWorkspaceState();
}

class _SocialWorkspaceState extends State<SocialWorkspace> {
  int tab = 0;
  String draftFilter = 'All';
  String draftQuery = '', templateQuery = '', templateFilter = 'All';
  bool sortByTitle = false, templateSortByTitle = false;
  String calendarFilter = 'All';
  late DateTime selectedDay;
  int selectedTemplate = 0;
  final draftSearchController = TextEditingController();
  final templateSearchController = TextEditingController();
  final thumbnailCache = <String, ({String encoded, Uint8List bytes})>{};

  static const tabs = ['Calendar', 'Drafts', 'Ideas', 'Brand', 'Templates'];
  static const platforms = [
    'Instagram',
    'LinkedIn',
    'X',
    'Facebook',
    'Threads',
    'TikTok',
    'YouTube',
    'Reddit',
    'Other',
  ];
  static const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);

    selectedDay = today;
  }

  @override
  void dispose() {
    draftSearchController.dispose();
    templateSearchController.dispose();
    super.dispose();
  }

  String date(DateTime d) => '${months[d.month - 1]} ${d.day}';

  @override
  void didUpdateWidget(covariant SocialWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    final ids = widget.drafts.whereType<Map>().map((d) => '${d['id']}').toSet();
    thumbnailCache.removeWhere((id, _) => !ids.contains(id));
  }

  Widget panel(Widget child, {EdgeInsets padding = const EdgeInsets.all(18)}) =>
      Container(
        padding: padding,
        decoration: BoxDecoration(
          color: panelColor,
          border: Border.all(color: line2),
          borderRadius: BorderRadius.circular(12),
        ),
        child: child,
      );

  Future<void> request([String initial = '']) async {
    final submit = widget.onGenerate;
    if (submit != null && !widget.busy) await submit(initial);
  }

  Widget generateButton({String label = 'Generate'}) => FilledButton.icon(
    onPressed: widget.onGenerate == null || widget.busy ? null : request,
    icon: const Icon(Icons.auto_awesome_outlined, size: 16),
    label: Text(label),
  );

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    key: const Key('social-screen'),
    padding: const EdgeInsets.fromLTRB(24, 22, 24, 30),
    child: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1480),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Social',
                        style: TextStyle(
                          fontSize: 24,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      SizedBox(height: 3),
                      Text(
                        'Turn your ideas into platform-ready content with AI agents.',
                        style: TextStyle(color: muted),
                      ),
                    ],
                  ),
                ),
                generateButton(),
              ],
            ),
            if (widget.onGenerate == null)
              const Padding(
                padding: EdgeInsets.only(top: 10),
                child: Text(
                  'Agent-request integration is not connected in this build.',
                  style: TextStyle(color: muted, fontSize: 12),
                ),
              ),
            if ((widget.selectedDraft?['operation'] as Map?)?['status'] ==
                'running')
              panel(
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'A previous Meta request is running or was interrupted; it may still finish and may be billed.',
                      style: TextStyle(color: warning),
                    ),
                    TextButton(
                      onPressed: widget.busy ? null : widget.onRecover,
                      child: const Text('Recover interrupted request'),
                    ),
                  ],
                ),
              ),
            if ((widget.selectedDraft?['operation'] as Map?)?['status'] ==
                'uncertain')
              panel(
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'A previous Meta request may have completed and may be billed. A retry could be billed again.',
                      style: TextStyle(color: warning),
                    ),
                    TextButton(
                      onPressed: widget.busy ? null : widget.onAcknowledge,
                      child: const Text('Acknowledge uncertainty'),
                    ),
                  ],
                ),
              ),
            if (widget.error != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: SelectableText(
                  widget.error!,
                  style: const TextStyle(color: danger),
                ),
              ),
            const SizedBox(height: 12),
            imageSourceStatus(),
            const SizedBox(height: 12),
            LayoutBuilder(
              builder: (context, constraints) {
                final navigation = SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (var i = 0; i < tabs.length; i++)
                        Padding(
                          padding: const EdgeInsets.only(right: 22),
                          child: InkWell(
                            key: Key('social-tab-${tabs[i].toLowerCase()}'),
                            onTap: () => setState(() => tab = i),
                            child: Container(
                              padding: const EdgeInsets.only(bottom: 10),
                              decoration: BoxDecoration(
                                border: Border(
                                  bottom: BorderSide(
                                    color: tab == i
                                        ? accent
                                        : Colors.transparent,
                                    width: 2,
                                  ),
                                ),
                              ),
                              child: Text(
                                tabs[i],
                                style: TextStyle(
                                  color: tab == i ? ink : muted,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                );
                if (tab != 0 && tab != 1 && tab != 4) return navigation;
                final controls = tab == 0
                    ? dayNavigation()
                    : libraryToolbar(
                        tab == 1 ? 'Search drafts' : 'Search templates',
                        (value) => setState(() {
                          if (tab == 1) {
                            draftQuery = value;
                          } else {
                            templateQuery = value;
                          }
                        }),
                        tab == 1 ? sortByTitle : templateSortByTitle,
                        (value) => setState(() {
                          if (tab == 1) {
                            sortByTitle = value;
                          } else {
                            templateSortByTitle = value;
                          }
                        }),
                        controller: tab == 1
                            ? draftSearchController
                            : templateSearchController,
                      );
                return constraints.maxWidth >= 850
                    ? Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          Expanded(child: navigation),
                          const SizedBox(width: 16),
                          if (tab == 0)
                            controls
                          else
                            SizedBox(width: 360, child: controls),
                        ],
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          navigation,
                          const SizedBox(height: 8),
                          if (tab == 0)
                            Align(
                              alignment: Alignment.centerRight,
                              child: controls,
                            )
                          else
                            controls,
                          const SizedBox(height: 8),
                        ],
                      );
              },
            ),
            const Divider(height: 1, color: line2),
            const SizedBox(height: 18),
            switch (tab) {
              0 => calendar(),
              1 => draftLibrary(),
              2 => ideas(),
              3 => brand(),
              _ => templates(),
            },
          ],
        ),
      ),
    ),
  );

  DateTime? createdAt(dynamic item) {
    if (item is! Map || item['createdAt'] is! String) return null;
    return DateTime.tryParse(item['createdAt'] as String)?.toLocal();
  }

  String draftFormat(dynamic item) {
    if (item is! Map) return 'Platform not specified';
    final platform = item['platform']?.toString().trim() ?? '';
    final format = item['format']?.toString().trim() ?? '';
    final label = [
      if (platform.isNotEmpty) platform,
      if (format.isNotEmpty) format,
    ].join(' · ');
    return label.isEmpty ? 'Platform not specified' : label;
  }

  bool onDay(DateTime? value, DateTime day) =>
      value != null &&
      value.year == day.year &&
      value.month == day.month &&
      value.day == day.day;

  bool matchesPlatform(dynamic item, String filter) {
    if (filter == 'All') return true;
    if (item is! Map) return false;
    final value = (item['platform']?.toString() ?? '').trim().toLowerCase();
    if (filter == 'Other') {
      return value.isNotEmpty &&
          !platforms
              .take(platforms.length - 1)
              .any((p) => p.toLowerCase() == value);
    }
    return value == filter.toLowerCase();
  }

  String platformName(dynamic item) {
    if (item is! Map) return 'Platform not specified';
    final name = item['platform']?.toString().trim() ?? '';
    return name.isEmpty ? 'Platform not specified' : name;
  }

  Widget platformMark(dynamic item) {
    final name = platformName(item).toLowerCase();
    return SocialPlatformLogo(name);
  }

  Widget platformFilters(
    List<dynamic> items,
    String current,
    ValueChanged<String> choose, {
    String keyPrefix = 'draft-filter',
  }) => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      children: [
        for (final name in ['All', ...platforms])
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: _PlatformFilterChip(
              key: Key('$keyPrefix-$name'),
              name: name,
              count: items.where((item) => matchesPlatform(item, name)).length,
              selected: current == name,
              onSelected: () => choose(name),
            ),
          ),
      ],
    ),
  );

  void changeDay(int direction) => setState(() {
    selectedDay = DateTime(
      selectedDay.year,
      selectedDay.month,
      selectedDay.day + direction,
    );
    calendarFilter = 'All';
  });

  Widget dayNavigation() => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      IconButton(
        key: const Key('social-previous-day'),
        tooltip: 'Previous day',
        onPressed: () => changeDay(-1),
        icon: const Icon(Icons.chevron_left, size: 18),
      ),
      TextButton.icon(
        key: const Key('social-selected-date'),
        icon: const Icon(Icons.calendar_today_outlined, size: 14),
        label: Text('${date(selectedDay)}, ${selectedDay.year}'),
        onPressed: () async {
          final picked = await showDatePicker(
            context: context,
            initialDate: selectedDay,
            firstDate: DateTime(2000),
            lastDate: DateTime(2100),
          );
          if (picked != null && mounted) {
            setState(() {
              selectedDay = picked;
              calendarFilter = 'All';
            });
          }
        },
      ),
      IconButton(
        key: const Key('social-next-day'),
        tooltip: 'Next day',
        onPressed: () => changeDay(1),
        icon: const Icon(Icons.chevron_right, size: 18),
      ),
      TextButton(
        onPressed: () => setState(() {
          final now = DateTime.now();
          selectedDay = DateTime(now.year, now.month, now.day);
          calendarFilter = 'All';
        }),
        child: const Text('Today'),
      ),
    ],
  );

  Widget imageSourceStatus() => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    decoration: BoxDecoration(
      color: accentWash,
      border: Border.all(color: accent.withValues(alpha: 0.25)),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      children: [
        const Icon(Icons.image_outlined, size: 18, color: accentSoft),
        const SizedBox(width: 10),
        Expanded(
          child: Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text(
                'Image generation',
                style: TextStyle(color: ink2, fontSize: 12),
              ),
              Text(
                widget.imageProvider.isEmpty
                    ? 'Source unavailable'
                    : widget.imageProvider == 'meta'
                    ? 'Meta API'
                    : 'Local SVG skill',
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 12,
                ),
              ),
              Text(
                widget.imageProvider.isEmpty
                    ? 'Use Change to check settings'
                    : widget.imageProvider == 'local'
                    ? 'No image key needed'
                    : widget.metaConfigured == null
                    ? 'Checking key…'
                    : widget.metaConfigured!
                    ? 'Key saved'
                    : 'Key missing',
                style: TextStyle(
                  color:
                      widget.imageProvider == 'meta' &&
                          widget.metaConfigured == false
                      ? warning
                      : muted,
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        TextButton(
          key: const Key('social-change-image-provider'),
          onPressed: widget.busy ? null : widget.onChangeImageProvider,
          style: TextButton.styleFrom(foregroundColor: accentSoft),
          child: const Text('Change'),
        ),
      ],
    ),
  );

  Widget emptyCalendar(bool hasDatedDrafts) => Center(
    child: Column(
      children: [
        const SizedBox(height: 30),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 929),
          child: Image.asset(
            'assets/social/empty-calendar.jpg',
            fit: BoxFit.contain,
            semanticLabel: 'A phone request becomes posts for Instagram, LinkedIn, X, TikTok and YouTube',
          ),
        ),
        const SizedBox(height: 12),
        Text(
          widget.drafts.isEmpty
              ? 'No posts yet'
              : hasDatedDrafts
              ? 'No drafts for this day'
              : 'No drafts on this day',
          style: const TextStyle(
            fontSize: 32,
            fontWeight: FontWeight.w700,
            letterSpacing: -.7,
          ),
        ),
        const SizedBox(height: 8),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 630),
          child: Text(
            'Your AI agents can research, plan and create platform-ready posts from a simple message.',
            textAlign: TextAlign.center,
            style: TextStyle(color: ink2, fontSize: 18, height: 1.4),
          ),
        ),
        const SizedBox(height: 20),
        generateButton(label: 'Generate drafts'),
        const SizedBox(height: 12),
        const Text(
          'Describe what you want in plain language, from your phone or here on desktop.\nReview your drafts here, then post them yourself.',
          textAlign: TextAlign.center,
          style: TextStyle(color: muted, height: 1.5),
        ),
        const SizedBox(height: 28),
        const Text(
          'TRY A QUICK EXAMPLE',
          style: TextStyle(color: faint, fontSize: 10, letterSpacing: 1),
        ),
        const SizedBox(height: 12),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: 10,
          runSpacing: 10,
          children: [
            exampleCard(
              Icons.wb_sunny_outlined,
              'Create 7 days of posts',
              'for a salon business',
              'Create seven days of social drafts for a salon business.',
            ),
            exampleCard(
              Icons.view_week_outlined,
              'Share product updates',
              'for this week',
              'Create social drafts about our product updates this week.',
            ),
            exampleCard(
              Icons.flag_outlined,
              'Create a LinkedIn',
              'thought leadership series',
              'Create a LinkedIn thought leadership series.',
            ),
            exampleCard(
              Icons.camera_alt_outlined,
              'Make Instagram posts',
              'for small businesses',
              'Create Instagram posts for small businesses.',
            ),
          ],
        ),
      ],
    ),
  );

  Widget exampleCard(
    IconData icon,
    String title,
    String subtitle,
    String prompt,
  ) => SizedBox(
    width: 205,
    child: OutlinedButton(
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 17),
        backgroundColor: const Color(0xff101519),
        side: const BorderSide(color: Color(0xff283036)),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
      onPressed: widget.onGenerate == null || widget.busy
          ? null
          : () => request(prompt),
      child: Row(
        children: [
          Icon(icon, size: 22, color: accentSoft),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontSize: 12, color: ink)),
                Text(
                  subtitle,
                  style: const TextStyle(fontSize: 11, color: muted),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );

  Widget calendar() {
    final dayItems = widget.drafts
        .where((item) => onDay(createdAt(item), selectedDay))
        .toList();
    final visible = dayItems
        .where((item) => matchesPlatform(item, calendarFilter))
        .toList();
    final hasDatedDrafts = widget.drafts.any((item) => createdAt(item) != null);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.hasMore)
          const Padding(
            padding: EdgeInsets.only(bottom: 12),
            child: Text(
              'Showing loaded drafts by creation date. Load older drafts in Drafts.',
              style: TextStyle(color: muted, fontSize: 11),
            ),
          ),
        if (dayItems.isEmpty)
          emptyCalendar(hasDatedDrafts)
        else ...[
          platformFilters(
            dayItems,
            calendarFilter,
            (value) => setState(() => calendarFilter = value),
            keyPrefix: 'calendar-filter',
          ),
          const SizedBox(height: 12),
          if (visible.isEmpty)
            panel(
              const Text(
                'No loaded drafts for this platform on this day.',
                style: TextStyle(color: muted),
              ),
            )
          else
            LayoutBuilder(
              builder: (context, constraints) =>
                  draftGrid(visible, constraints.maxWidth, fromCalendar: true),
            ),
        ],
        if (widget.drafts.any((item) => createdAt(item) == null))
          const Padding(
            padding: EdgeInsets.only(top: 14),
            child: Text(
              'Older undated drafts are available in Drafts.',
              style: TextStyle(color: muted, fontSize: 11),
            ),
          ),
      ],
    );
  }

  Widget draftArtwork(dynamic item, {double height = 125}) {
    final selected = item is Map && widget.selectedDraft?['id'] == item['id'];
    Uint8List? thumbnail;
    final encoded = item is Map ? item['thumbnail'] : null;
    if (encoded is String && encoded.length <= 134000) {
      try {
        final id = '${item['id']}';
        final cached = thumbnailCache[id];
        thumbnail = cached?.encoded == encoded
            ? cached!.bytes
            : base64Decode(encoded);
        if (thumbnailCache.length < 100 || thumbnailCache.containsKey(id)) {
          thumbnailCache[id] = (encoded: encoded, bytes: thumbnail);
        }
      } on FormatException {
        thumbnail = null;
      }
    }
    final bytes = (selected ? widget.imageBytes : null) ?? thumbnail;
    return Container(
      key: Key('social-media-${item is Map ? item['id'] : 'unknown'}'),
      height: height,
      width: double.infinity,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: const Color(0xff171c20),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xff30373d)),
      ),
      child: bytes != null
          ? Image.memory(
              bytes,
              fit: BoxFit.contain,
              cacheWidth: 1024,
              gaplessPlayback: true,
              semanticLabel: 'Saved draft image',
              errorBuilder: (_, _, _) => const Center(
                child: Text(
                  'Image preview unavailable',
                  style: TextStyle(color: muted, fontSize: 11),
                ),
              ),
            )
          : Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.image_outlined, size: 25, color: faint),
                const SizedBox(height: 7),
                Text(
                  selected && widget.imageInvalid
                      ? 'The saved image is invalid or too large to display.'
                      : selected
                      ? 'No image generated'
                      : 'No image preview available',
                  style: const TextStyle(color: muted, fontSize: 11),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
    );
  }

  Widget draftCard(dynamic item, double width, {bool fromCalendar = false}) {
    final id = item is Map ? item['id']?.toString() ?? '' : '';
    final title = item is Map
        ? '${item['brief'] ?? 'Untitled draft'}'
        : 'Untitled draft';
    final selected = id.isNotEmpty && widget.selectedDraft?['id'] == id;
    return SizedBox(
      width: width,
      child: Semantics(
        label: title,
        selected: selected,
        button: true,
        child: Material(
          color: const Color(0xff101519),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
            side: BorderSide(
              color: selected ? accent : const Color(0xff283036),
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            key: Key('social-draft-card-$id'),
            onTap: widget.busy || id.isEmpty
                ? null
                : () {
                    widget.onSelectDraft?.call(id);
                  },
            child: Padding(
              padding: const EdgeInsets.all(11),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    height: 36,
                    child: Row(
                      children: [
                        platformMark(item),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            platformName(item),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        draftActions(
                          selected
                              ? widget.selectedDraft!
                              : item is Map
                              ? Map<String, dynamic>.from(item)
                              : <String, dynamic>{},
                          selected: selected,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 11),
                  Stack(
                    children: [
                      draftArtwork(item, height: 320),
                      if (selected && widget.slideCount > 1) ...[
                        Positioned(
                          left: 10,
                          top: 0,
                          bottom: 0,
                          child: Center(child: slideArrow(previous: true)),
                        ),
                        Positioned(
                          right: 10,
                          top: 0,
                          bottom: 0,
                          child: Center(child: slideArrow(previous: false)),
                        ),
                        Positioned(
                          right: 12,
                          bottom: 12,
                          child: IgnorePointer(
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 5,
                              ),
                              decoration: BoxDecoration(
                                color: const Color(0xc0080808),
                                borderRadius: BorderRadius.circular(20),
                              ),
                              child: Text(
                                '${widget.selectedSlide + 1} / ${widget.slideCount}',
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 11,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 10),
                  if (selected)
                    SelectableText(
                      '${widget.selectedDraft?['caption'] ?? ''}',
                      style: const TextStyle(
                        color: ink2,
                        fontSize: 12,
                        height: 1.4,
                      ),
                    )
                  else
                    Text(
                      '${item is Map ? item['caption'] ?? '' : ''}',
                      style: const TextStyle(
                        color: ink2,
                        fontSize: 12,
                        height: 1.4,
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget draftGrid(
    List<dynamic> items,
    double width, {
    bool fromCalendar = false,
  }) {
    final columns = width >= 960
        ? 3
        : width >= 680
        ? 2
        : 1;
    final cardWidth = (width - 10 * (columns - 1)) / columns;
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        for (final item in items)
          draftCard(item, cardWidth, fromCalendar: fromCalendar),
      ],
    );
  }

  Widget slideArrow({required bool previous}) => IconButton.filled(
    tooltip: previous ? 'Previous slide' : 'Next slide',
    onPressed:
        widget.busy ||
            widget.onSelectSlide == null ||
            (previous
                ? widget.selectedSlide == 0
                : widget.selectedSlide + 1 >= widget.slideCount)
        ? null
        : () =>
              widget.onSelectSlide!(widget.selectedSlide + (previous ? -1 : 1)),
    style: IconButton.styleFrom(
      backgroundColor: const Color(0xc0080808),
      foregroundColor: Colors.white,
      disabledBackgroundColor: const Color(0x70080808),
      disabledForegroundColor: const Color(0x70ffffff),
      minimumSize: const Size(34, 34),
      padding: const EdgeInsets.all(5),
    ),
    icon: Icon(previous ? Icons.chevron_left : Icons.chevron_right, size: 22),
  );

  Widget draftActions(Map<String, dynamic> item, {required bool selected}) {
    final id = '${item['id'] ?? ''}';
    VoidCallback? action(SocialDraftAction kind, VoidCallback? fallback) {
      if (widget.busy || id.isEmpty) return null;
      if (kind == SocialDraftAction.copy &&
          '${item['caption'] ?? ''}'.trim().isEmpty) {
        return null;
      }
      if (kind == SocialDraftAction.export &&
          selected &&
          widget.imageBytes == null) {
        return null;
      }
      if (widget.onDraftAction != null) {
        return () => widget.onDraftAction!(id, kind);
      }
      return selected ? fallback : null;
    }

    Widget button(
      String key,
      String tooltip,
      IconData icon,
      VoidCallback? callback,
    ) => IconButton(
      key: Key(selected ? key : '$key-$id'),
      tooltip: tooltip,
      onPressed: callback,
      style: IconButton.styleFrom(
        minimumSize: const Size(32, 32),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        padding: const EdgeInsets.all(6),
      ),
      icon: Icon(icon, size: 18),
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        button(
          'social-share-post',
          'Share / Open in…',
          Icons.ios_share,
          action(SocialDraftAction.share, widget.onShare),
        ),
        button(
          'social-copy-caption',
          'Copy caption',
          Icons.copy_outlined,
          action(SocialDraftAction.copy, widget.onCopy),
        ),
        button(
          'social-export-image',
          selected && widget.slideCount > 1
              ? 'Export slide ${widget.selectedSlide + 1}'
              : 'Export image',
          Icons.file_download_outlined,
          action(SocialDraftAction.export, widget.onExportImage),
        ),
        button(
          'social-delete-draft',
          'Delete draft',
          Icons.delete_outline,
          action(SocialDraftAction.delete, widget.onDelete),
        ),
      ],
    );
  }

  Widget draftLibrary() {
    if (widget.drafts.isEmpty) {
      return panel(
        const Text(
          'No drafts yet. Ask an agent for a draft to see it here.',
          style: TextStyle(color: muted),
        ),
      );
    }
    final visible = widget.drafts
        .where(
          (item) =>
              matchesPlatform(item, draftFilter) &&
              (item is Map
                      ? '${item['brief'] ?? ''} ${item['caption'] ?? ''}'
                      : '')
                  .toLowerCase()
                  .contains(draftQuery.toLowerCase()),
        )
        .toList();
    visible.sort(
      (a, b) => sortByTitle
          ? '${a['brief'] ?? ''}'.compareTo('${b['brief'] ?? ''}')
          : (createdAt(b) ?? DateTime(1970)).compareTo(
              createdAt(a) ?? DateTime(1970),
            ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        platformFilters(
          widget.drafts,
          draftFilter,
          (value) => setState(() => draftFilter = value),
        ),
        if (widget.hasMore)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text(
              'Filters and counts apply to loaded drafts.',
              style: TextStyle(color: muted, fontSize: 11),
            ),
          ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) {
            Widget cards(double width) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (visible.isEmpty)
                  panel(
                    const Text(
                      'No loaded drafts for this platform.',
                      style: TextStyle(color: muted),
                    ),
                  )
                else
                  draftGrid(visible, width),
                if (widget.hasMore)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      onPressed: widget.busy ? null : widget.onLoadMore,
                      child: const Text('Load older drafts'),
                    ),
                  ),
              ],
            );
            return cards(constraints.maxWidth);
          },
        ),
      ],
    );
  }

  Widget ideas() {
    final library = panel(
      ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 300),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: accentWash,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(
                  Icons.lightbulb_outline_rounded,
                  color: accentSoft,
                  size: 23,
                ),
              ),
              const SizedBox(height: 15),
              const Text(
                'Your next great post starts here',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 6),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 330),
                child: const Text(
                  'Ask your agents to research your topic and turn the strongest angles into drafts with sources.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: muted, fontSize: 12),
                ),
              ),
              const SizedBox(height: 22),
              FilledButton.icon(
                onPressed: widget.onGenerate == null || widget.busy
                    ? null
                    : () => request(
                        'Research social content ideas for my brand and audience. Ask for missing context, cite sources, and save the strongest ideas as drafts.',
                      ),
                icon: const Icon(Icons.auto_awesome_outlined, size: 16),
                label: const Text('Research ideas'),
              ),
              const SizedBox(height: 14),
              const Text(
                'Ideas are saved as drafts. A separate idea library is not available yet.',
                textAlign: TextAlign.center,
                style: TextStyle(color: muted, fontSize: 11),
              ),
            ],
          ),
        ),
      ),
    );
    final detail = panel(
      const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Idea details', style: TextStyle(fontWeight: FontWeight.w700)),
          SizedBox(height: 14),
          Text(
            'From a topic to a useful story',
            style: TextStyle(color: ink2, fontSize: 12),
          ),
          SizedBox(height: 14),
          Divider(color: line2, height: 1),
          SizedBox(height: 14),
          Text(
            'Suggested platform and format',
            style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
          ),
          SizedBox(height: 5),
          Text(
            'Your agent will suggest the right treatment for each topic.',
            style: TextStyle(color: muted, fontSize: 12),
          ),
          SizedBox(height: 14),
          Text(
            'Sources',
            style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
          ),
          SizedBox(height: 5),
          Text(
            'Research links are saved with generated drafts.',
            style: TextStyle(color: muted, fontSize: 12),
          ),
        ],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Research-backed ideas',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 4),
        const Text(
          'Suggestions from agents, with sources and suggested formats.',
          style: TextStyle(color: muted, fontSize: 12),
        ),
        const SizedBox(height: 14),
        LayoutBuilder(
          builder: (context, constraints) {
            if (constraints.maxWidth < 720) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [library, const SizedBox(height: 12), detail],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: library),
                const SizedBox(width: 12),
                SizedBox(width: 300, child: detail),
              ],
            );
          },
        ),
      ],
    );
  }

  Widget brandCard(
    IconData icon,
    String title,
    String description,
    double width,
  ) => SizedBox(
    width: width,
    child: Container(
      constraints: const BoxConstraints(minHeight: 125),
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: const Color(0xff101519),
        border: Border.all(color: const Color(0xff283036)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 16, color: ink2),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 12,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 13),
          Text(description, style: const TextStyle(color: muted, fontSize: 12)),
          const SizedBox(height: 7),
          const Text(
            'Include this in your generation brief',
            style: TextStyle(color: faint, fontSize: 11),
          ),
        ],
      ),
    ),
  );

  Widget brand() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      panel(
        Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: accentWash,
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(
                Icons.palette_outlined,
                color: accentSoft,
                size: 21,
              ),
            ),
            const SizedBox(width: 12),
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Your brand, in every post',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                  ),
                  SizedBox(height: 4),
                  Text(
                    'Give your agents a clear identity, audience and visual direction.',
                    style: TextStyle(color: muted, fontSize: 12),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            TextButton.icon(
              onPressed: widget.onGenerate == null || widget.busy
                  ? null
                  : () => request(
                      'Help me define my brand for a social content brief. Ask for my brand name, website, audience, voice, key topics, colours and visual references before generating.',
                    ),
              icon: const Icon(Icons.edit_outlined, size: 16),
              label: const Text('Define brand'),
            ),
          ],
        ),
      ),
      const SizedBox(height: 10),
      LayoutBuilder(
        builder: (context, constraints) {
          final columns = constraints.maxWidth >= 720
              ? 3
              : constraints.maxWidth >= 430
              ? 2
              : 1;
          final width = (constraints.maxWidth - 10 * (columns - 1)) / columns;
          return Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              brandCard(
                Icons.description_outlined,
                'Brand overview',
                'Brand name\nTagline\nShort description\nWebsite',
                width,
              ),
              brandCard(
                Icons.people_outline_rounded,
                'Target audience',
                'Who you want to reach\nIndustries\nLocation\nAudience goals',
                width,
              ),
              brandCard(
                Icons.mic_none_rounded,
                'Brand voice',
                'Tone of voice\nWriting guidelines\nWords to use\nWords to avoid',
                width,
              ),
              brandCard(
                Icons.tag_rounded,
                'Key topics',
                'Product updates\nUseful advice\nCustomer questions\nYour areas of expertise',
                width,
              ),
              brandCard(
                Icons.palette_outlined,
                'Visual identity',
                'Brand colours\nType and layout references\nPhotography style\nVisual examples',
                width,
              ),
              brandCard(
                Icons.image_outlined,
                'Logo & assets',
                'Logo and wordmark\nProduct imagery\nApproved artwork\nReference links',
                width,
              ),
            ],
          );
        },
      ),
      const SizedBox(height: 18),
      panel(
        const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Example content style',
              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
            ),
            SizedBox(height: 7),
            Text(
              'Share approved examples in your generation request. A saved brand profile and asset library are not available in this build.',
              style: TextStyle(color: muted, fontSize: 12),
            ),
          ],
        ),
        padding: const EdgeInsets.all(15),
      ),
    ],
  );

  static const templateData =
      <
        ({
          String title,
          String platform,
          String format,
          String description,
          String art,
        })
      >[
        (
          title: 'Product launch carousel',
          platform: 'Instagram',
          format: 'Carousel',
          description: 'Showcase your product, key benefits and real use cases in a clean carousel.',
          art: 'assets/social/template-0.jpg',
        ),
        (
          title: 'Thought leadership article',
          platform: 'LinkedIn',
          format: 'Article',
          description: 'A long-form LinkedIn post with insights, industry trends and practical advice.',
          art: 'assets/social/template-1.jpg',
        ),
        (
          title: 'X thread',
          platform: 'X',
          format: 'Thread',
          description: 'A concise, high-impact thread with actionable tips and examples.',
          art: 'assets/social/template-2.jpg',
        ),
        (
          title: 'Behind the scenes video',
          platform: 'TikTok',
          format: 'Video script',
          description: 'A short, relatable video showing how your business uses AI in real life.',
          art: 'assets/social/template-3.jpg',
        ),
        (
          title: 'Educational video script',
          platform: 'YouTube',
          format: 'Video script',
          description: 'A step-by-step video script to educate your audience and drive interest.',
          art: 'assets/social/template-4.jpg',
        ),
        (
          title: 'Benefit-focused post',
          platform: 'Instagram',
          format: 'Single image',
          description: 'A clean, visual post highlighting a key benefit with a simple message.',
          art: 'assets/social/template-5.jpg',
        ),
        (
          title: 'Company update',
          platform: 'LinkedIn',
          format: 'Company update',
          description: 'Share an important milestone with your community.',
          art: 'assets/social/template-6.jpg',
        ),
        (
          title: 'Community poll',
          platform: 'X',
          format: 'Poll',
          description: 'Learn what matters most to your audience.',
          art: 'assets/social/template-7.jpg',
        ),
        (
          title: 'Trend / meme',
          platform: 'TikTok',
          format: 'Trend / meme',
          description: 'Bring a timely, relatable idea to life.',
          art: 'assets/social/template-8.jpg',
        ),
      ];

  Widget templateArtwork(int index, {double height = 150}) => ClipRRect(
    borderRadius: BorderRadius.circular(8),
    child: AspectRatio(
      aspectRatio: 274 / 122,
      child: Image.asset(
        templateData[index].art,
        width: double.infinity,
        fit: BoxFit.contain,
        semanticLabel: 'Illustrative ${templateData[index].title} example',
      ),
    ),
  );

  String templatePrompt(int index) {
    final item = templateData[index];
    return 'Create a ${item.title} for ${item.platform}. Format: ${item.format}. ${item.description} '
        'Use my brand and audience context; ask for missing essential details. '
        'Research factual claims when needed and cite sources. Save the result as a draft. '
        'For video, prepare a script and storyboard; do not claim a rendered video without a video tool.';
  }

  Widget libraryToolbar(
    String hint,
    ValueChanged<String> search,
    bool byTitle,
    ValueChanged<bool> sort, {
    required TextEditingController controller,
  }) => Row(
    children: [
      Expanded(
        child: TextField(
          key: ValueKey(hint),
          controller: controller,
          onChanged: search,
          decoration: InputDecoration(
            hintText: hint,
            prefixIcon: const Icon(Icons.search, size: 18),
            isDense: true,
          ),
        ),
      ),
      const SizedBox(width: 14),
      DropdownButton<bool>(
        value: byTitle,
        underline: const SizedBox.shrink(),
        items: const [
          DropdownMenuItem(value: false, child: Text('Newest first')),
          DropdownMenuItem(value: true, child: Text('Title A to Z')),
        ],
        onChanged: (v) {
          if (v != null) sort(v);
        },
      ),
    ],
  );

  Widget templateCard(int index, double width) {
    final item = templateData[index];
    final selected = selectedTemplate == index;
    return SizedBox(
      width: width,
      child: Semantics(
        selected: selected,
        label: '${item.title}, ${item.platform}, ${item.format}',
        child: Material(
          color: panelColor,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
            side: BorderSide(color: selected ? accent : line2),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            key: Key('social-template-card-$index'),
            onTap: () => setState(() => selectedTemplate = index),
            child: Padding(
              padding: const EdgeInsets.all(11),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      platformMark({'platform': item.platform}),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          item.platform,
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Text(
                        item.format,
                        style: const TextStyle(color: muted, fontSize: 10),
                      ),
                    ],
                  ),
                  const SizedBox(height: 9),
                  templateArtwork(index),
                  const SizedBox(height: 10),
                  Text(
                    item.title,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    item.description,
                    style: const TextStyle(color: muted, fontSize: 12),
                  ),
                  const SizedBox(height: 10),
                  OutlinedButton(
                    key: Key('social-use-template-$index'),
                    onPressed: widget.onGenerate == null || widget.busy
                        ? null
                        : () => request(templatePrompt(index)),
                    child: const Text('Use template'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget templateGrid(double width) {
    final columns = width >= 1080
        ? 3
        : width >= 680
        ? 2
        : 1;
    final cardWidth = (width - 11 * (columns - 1)) / columns - .01;
    final indices = List.generate(templateData.length, (i) => i)
        .where(
          (i) =>
              (templateFilter == 'All' ||
                  templateData[i].platform == templateFilter) &&
              '${templateData[i].title} ${templateData[i].description}'
                  .toLowerCase()
                  .contains(templateQuery.toLowerCase()),
        )
        .toList();
    if (templateSortByTitle) {
      indices.sort(
        (a, b) => templateData[a].title.compareTo(templateData[b].title),
      );
    }
    if (indices.isEmpty) {
      return panel(const Text('No templates match your search.'));
    }
    return Wrap(
      spacing: 11,
      runSpacing: 11,
      children: [for (final i in indices) templateCard(i, cardWidth)],
    );
  }

  Widget templates() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      platformFilters(
        [
          for (final t in templateData) {'platform': t.platform},
        ],
        templateFilter,
        (v) => setState(() => templateFilter = v),
        keyPrefix: 'template-filter',
      ),
      const SizedBox(height: 14),
      LayoutBuilder(
        builder: (context, constraints) => templateGrid(constraints.maxWidth),
      ),
      const SizedBox(height: 12),
      const Text(
        'Templates start agent requests; they do not publish content.',
        style: TextStyle(color: muted, fontSize: 11),
      ),
    ],
  );
}

class _PlatformFilterChip extends StatefulWidget {
  const _PlatformFilterChip({
    super.key,
    required this.name,
    required this.count,
    required this.selected,
    required this.onSelected,
  });
  final String name;
  final int count;
  final bool selected;
  final VoidCallback onSelected;

  @override
  State<_PlatformFilterChip> createState() => _PlatformFilterChipState();
}

class _PlatformFilterChipState extends State<_PlatformFilterChip> {
  bool hovered = false, focused = false;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '${widget.name}, ${widget.count} drafts',
    selected: widget.selected,
    button: true,
    child: InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: widget.onSelected,
      onHover: (value) => setState(() => hovered = value),
      onFocusChange: (value) => setState(() => focused = value),
      child: AnimatedSize(
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : const Duration(milliseconds: 160),
        alignment: Alignment.centerLeft,
        curve: Curves.easeOutCubic,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: widget.selected ? accentWash : const Color(0xff101417),
            border: Border.all(
              color: widget.selected ? accent : const Color(0xff30383d),
            ),
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (widget.name == 'All')
                Icon(
                  Icons.apps_rounded,
                  size: 20,
                  color: widget.selected ? accentSoft : ink2,
                )
              else
                SocialPlatformLogo(widget.name),
              if (hovered || focused) ...[
                const SizedBox(width: 8),
                Text(
                  '${widget.name} (${widget.count})',
                  style: TextStyle(
                    color: widget.selected ? accentSoft : ink2,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}
