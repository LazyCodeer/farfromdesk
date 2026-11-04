import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'gateway.dart';
import 'social_share.dart';
import 'social_share_dialog.dart';
import 'social_jpeg.dart';
import 'social_generate_dialog.dart';
import 'social_workspace.dart';
import 'social_image_settings.dart';

/// Native UI initiated generation; publishing is not available.
class SocialScreen extends StatefulWidget {
  const SocialScreen({super.key, required this.gateway});
  final Gateway gateway;
  @override
  State<SocialScreen> createState() => SocialScreenState();
}

class SocialScreenState extends State<SocialScreen> {
  final brief = TextEditingController(),
      caption = TextEditingController(),
      prompt = TextEditingController(),
      newBrief = TextEditingController();
  List<dynamic> drafts = [];
  Map<String, dynamic>? draft;
  String? nextCursor, error;
  String imageProvider = '';
  bool? metaConfigured;
  Uint8List? imageBytes;
  List<Uint8List> carouselFrames = [];
  int selectedSlide = 0;
  bool imageInvalid = false;
  bool refreshing = false;
  int contentVersion = 0;
  bool busy = false,
      dirty = false,
      leaving = false,
      closeLocked = false,
      composingNewDraft = false;
  Gateway get api => widget.gateway;

  @override
  void initState() {
    super.initState();
    load().catchError((Object e) {
      if (mounted) setState(() => error = clean(e));
    });
    loadImageSettings();
  }

  Future<void> loadImageSettings() async {
    try {
      final settings = await api.get('/api/social/settings');
      if (mounted) {
        setState(() {
          imageProvider = settings['imageProvider'] == 'meta'
              ? 'meta'
              : 'local';
          metaConfigured = settings['metaConfigured'] == true;
        });
      }
    } catch (_) {
      if (mounted) setState(() => metaConfigured = null);
    }
  }

  Future<void> changeImageSettings() async {
    final settings = await showDialog<Map<String, dynamic>>(
      context: context,
      barrierDismissible: false,
      builder: (_) => SocialImageSettings(gateway: api),
    );
    if (mounted && settings != null) {
      setState(() {
        imageProvider = settings['imageProvider'] == 'meta' ? 'meta' : 'local';
        metaConfigured = settings['metaConfigured'] == true;
      });
    }
  }

  @override
  void dispose() {
    brief.dispose();
    caption.dispose();
    prompt.dispose();
    newBrief.dispose();
    super.dispose();
  }

  String clean(Object e) => e.toString().replaceFirst('Bad state: ', '');
  void apply(Map<String, dynamic> d, {bool preserveSlide = false}) {
    final previousSlide = preserveSlide && draft?['id'] == d['id']
        ? selectedSlide
        : 0;
    draft = d;
    brief.text = '${d['brief'] ?? ''}';
    caption.text = '${d['caption'] ?? ''}';
    prompt.text = '${d['imagePrompt'] ?? ''}';
    imageBytes = null;
    carouselFrames = [];
    selectedSlide = 0;
    imageInvalid = false;
    final storedImage = d['image'];
    if (storedImage is Map) {
      final encoded = storedImage['base64'];
      try {
        if (encoded is! String || !validSocialBase64(encoded)) {
          throw const FormatException();
        }
        final decoded = base64Decode(encoded);
        if (!safeSocialJpeg(decoded)) throw const FormatException();
        imageBytes = decoded;
      } catch (_) {
        imageInvalid = true;
      }
    }
    final carousel = d['carousel'];
    if (carousel is Map && carousel['slides'] is List) {
      try {
        final slides = carousel['slides'] as List;
        if (slides.isEmpty || slides.length > 8) {
          throw const FormatException();
        }
        carouselFrames = slides.map((slide) {
          final encoded = slide is Map ? slide['base64'] : null;
          if (encoded is! String || !validSocialBase64(encoded)) {
            throw const FormatException();
          }
          final bytes = base64Decode(encoded);
          if (!safeSocialJpeg(bytes)) throw const FormatException();
          return bytes;
        }).toList();
        selectedSlide = previousSlide.clamp(0, carouselFrames.length - 1);
        imageBytes = carouselFrames[selectedSlide];
        imageInvalid = false;
      } catch (_) {
        carouselFrames = [];
        imageBytes = null;
        imageInvalid = true;
      }
    }
    dirty = false;
  }

  Future<void> load({String? id, bool more = false}) async {
    contentVersion++;
    if (id != null) {
      final selected = await api.get(
        '/api/social?id=${Uri.encodeQueryComponent(id)}',
      );
      if (mounted) {
        setState(() => apply(Map<String, dynamic>.from(selected['draft'])));
      }
      return;
    }
    final path = more
        ? '/api/social?before=${Uri.encodeQueryComponent(nextCursor!)}'
        : '/api/social';
    final list = await api.get(path);
    if (!mounted) return;
    setState(() {
      final page = List<dynamic>.from(list['drafts'] ?? []);
      drafts = more ? [...drafts, ...page] : page;
      nextCursor = list['nextCursor'] as String?;
    });
  }

  /// Called by the existing app poll, not a second timer. Quiet updates retain
  /// the workspace, pagination and selected slide, and never overwrite edits.
  Future<void> refreshQuietly() async {
    if (refreshing || busy || dirty || closeLocked || composingNewDraft) return;
    refreshing = true;
    final version = contentVersion;
    final selectedId = draft?['id'];
    try {
      final result = await api.get('/api/social');
      if (!mounted || busy || dirty || version != contentVersion) return;
      final page = List<dynamic>.from(result['drafts'] ?? []);
      final ids = page.whereType<Map>().map((e) => e['id']).toSet();
      final boundary = page.isEmpty ? null : (page.last as Map)['cursor'];
      final older = result['nextCursor'] == null
          ? <dynamic>[]
          : drafts
                .where(
                  (e) =>
                      e is Map &&
                      !ids.contains(e['id']) &&
                      boundary is num &&
                      e['cursor'] is num &&
                      e['cursor'] < boundary,
                )
                .toList();
      final merged = [...page, ...older];
      Map<String, dynamic>? updated;
      final summary = page
          .whereType<Map>()
          .where((e) => e['id'] == selectedId)
          .firstOrNull;
      if (selectedId != null &&
          summary != null &&
          summary['revision'] != null &&
          summary['revision'] != draft?['revision']) {
        final detail = await api.get(
          '/api/social?id=${Uri.encodeQueryComponent(selectedId.toString())}',
        );
        updated = Map<String, dynamic>.from(detail['draft']);
      }
      if (!mounted ||
          busy ||
          dirty ||
          closeLocked ||
          composingNewDraft ||
          version != contentVersion ||
          selectedId != draft?['id']) {
        return;
      }
      final cursor = older.isEmpty
          ? result['nextCursor'] as String?
          : nextCursor;
      if (jsonEncode(merged) == jsonEncode(drafts) &&
          updated == null &&
          cursor == nextCursor) {
        return;
      }
      setState(() {
        drafts = merged;
        nextCursor = cursor;
        if (updated != null) apply(updated, preserveSlide: true);
      });
    } catch (_) {
      // Keep the last good content. The app's connection status owns failures.
    } finally {
      refreshing = false;
    }
  }

  Future<Map<String, dynamic>> call(
    String op, [
    Map<String, dynamic> data = const {},
  ]) async => Map<String, dynamic>.from(
    (await api.post('/api/social', {'op': op, ...data}))['result'] as Map,
  );
  Future<void> run(Future<void> Function() work) async {
    if (busy || closeLocked) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await work();
    } catch (e) {
      if (mounted) setState(() => error = clean(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Map<String, dynamic> get ref => {
    'id': draft!['id'],
    'revision': draft!['revision'],
  };
  Future<void> save() async {
    if (draft == null || !dirty) return;
    final result = await call('update', {
      ...ref,
      'fields': {
        'brief': brief.text,
        'caption': caption.text,
        'imagePrompt': prompt.text,
      },
    });
    if (mounted) setState(() => apply(result));
  }

  Future<bool> confirm(String title, String text, String action) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(text),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(action),
            ),
          ],
        ),
      ) ??
      false;

  /// Called by the app before leaving the Social tab, and before switching drafts.
  void releaseCloseLock() {
    if (mounted && closeLocked) setState(() => closeLocked = false);
  }

  Future<bool> allowLeave({bool forClose = false}) async {
    if (busy || leaving || closeLocked || composingNewDraft) return false;
    if (!dirty) {
      if (forClose && mounted) setState(() => closeLocked = true);
      return true;
    }
    leaving = true;
    try {
      final choice = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Unsaved draft'),
          content: const Text('Save your changes before leaving?'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, 'stay'),
              child: const Text('Stay'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, 'discard'),
              child: const Text('Discard changes'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, 'save'),
              child: const Text('Save draft'),
            ),
          ],
        ),
      );
      if (choice == 'discard') {
        if (forClose && mounted) setState(() => closeLocked = true);
        return true;
      }
      if (choice != 'save' || !mounted) return false;
      setState(() => busy = true);
      try {
        await save();
        if (forClose && mounted) setState(() => closeLocked = true);
        return true;
      } catch (e) {
        if (mounted) setState(() => error = clean(e));
        return false;
      } finally {
        if (mounted) setState(() => busy = false);
      }
    } finally {
      leaving = false;
    }
  }

  Future<void> create() async {
    if (!await allowLeave() || !mounted) return;
    newBrief.clear();
    composingNewDraft = true;
    String? value;
    try {
      value = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('New social draft'),
          content: TextField(
            controller: newBrief,
            autofocus: true,
            maxLength: 2000,
            decoration: const InputDecoration(labelText: 'Topic or brief'),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, newBrief.text),
              child: const Text('Create draft'),
            ),
          ],
        ),
      );
    } finally {
      composingNewDraft = false;
    }
    if (value == null || value.trim().isEmpty || !mounted) return;
    await run(() async {
      final d = await call('create', {'brief': value});
      if (mounted) setState(() => apply(d));
      await load();
    });
  }

  Future<void> switchDraft(String id) async {
    if (!await allowLeave() || !mounted) return;
    await run(() => load(id: id));
  }

  Future<void> performDraftAction(String id, SocialDraftAction action) async {
    if (busy || closeLocked) return;
    if (draft?['id'] != id) await switchDraft(id);
    // Cancelled/failed loads must never run an action on the previous card.
    if (!mounted || busy || closeLocked || draft?['id'] != id) return;
    switch (action) {
      case SocialDraftAction.share:
        await shareDraft();
      case SocialDraftAction.copy:
        await copyCaption();
      case SocialDraftAction.export:
        final bytes = imageBytes;
        if (bytes != null) {
          await run(() async {
            await api.saveSocialImage(bytes);
          });
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('This draft has no image to export.')),
          );
        }
      case SocialDraftAction.delete:
        await deleteDraft();
    }
  }

  Future<void> generate(String kind) async {
    await run(() async {
      await save();
      final generator = await api.prepareSocialGenerator();
      final id = draft!['id'] as String;
      String? operationId;
      Object? failure;
      var saved = false;
      try {
        final reservation = await call('begin', {...ref, 'kind': kind});
        operationId = reservation['operationId'] as String;
        final output = await generator(
          kind,
          Map<String, dynamic>.from(reservation['input'] as Map),
        );
        final response = await api.post('/api/social/result', {
          'id': id,
          'operationId': operationId,
          'result': output,
        });
        if (mounted) {
          setState(
            () => apply(Map<String, dynamic>.from(response['result'] as Map)),
          );
        }
        saved = true;
      } catch (error) {
        if (operationId != null) {
          try {
            final receipt = await api.get(
              '/api/social?id=${Uri.encodeQueryComponent(id)}&receipt=${Uri.encodeQueryComponent(operationId)}',
            );
            saved = receipt['receipt']?['status'] == 'completed';
          } catch (_) {
            /* The outcome remains unknown. */
          }
          if (!saved) {
            try {
              await call('fail', {'id': id, 'operationId': operationId});
            } catch (_) {
              /* The reservation remains blocked. */
            }
          }
        }
        if (!saved) {
          failure = operationId == null
              ? error
              : StateError(
                  '${clean(error)} The result may be uncertain and the request may be billed. Check the draft before retrying.',
                );
        }
      }
      try {
        await load(id: id);
      } catch (_) {
        if (saved) {
          throw StateError(
            'The result was saved, but could not be reloaded. Reopen the draft.',
          );
        }
        failure ??= StateError('The request status could not be reloaded.');
      }
      if (failure != null) throw failure;
    });
  }

  Future<void> recover() async {
    final target = {
      ...ref,
      'operationId': (draft?['operation'] as Map?)?['operationId'],
    };
    if (!await confirm(
          'Recover interrupted request?',
          'The earlier request may still finish and may be billed. Recovery discards any late result; a new request may be billed again.',
          'Recover request',
        ) ||
        !mounted) {
      return;
    }
    await run(() async {
      final result = await call('recover', target);
      if (mounted) setState(() => apply(result));
    });
  }

  Future<void> copyCaption() async {
    final text = caption.text;
    if (text.trim().isEmpty) return;
    await run(() async {
      await Clipboard.setData(ClipboardData(text: text));
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Caption copied. Review it again where you post.'),
          ),
        );
      }
    });
  }

  Future<void> deleteDraft() async {
    if (draft == null) return;
    if (!await confirm(
          'Delete draft?',
          'This removes the saved draft and any unsaved edits. Database or backup copies may remain.',
          'Delete draft',
        ) ||
        !mounted) {
      return;
    }
    await run(() async {
      await call('delete', {...ref, 'confirmed': true});
      if (mounted) {
        setState(() {
          draft = null;
          dirty = false;
        });
      }
      await load();
    });
  }

  Future<void> acknowledge() async {
    final target = {
      'id': draft!['id'],
      'operationId': (draft?['operation'] as Map?)?['operationId'],
    };
    if (!await confirm(
          'Acknowledge uncertain request?',
          'A previous request may have completed and may be billed. A new request could be billed again.',
          'Acknowledge',
        ) ||
        !mounted) {
      return;
    }
    await run(() async {
      final d = await call('acknowledge', target);
      if (mounted) setState(() => apply(d));
    });
  }

  Future<void> openGenerate(String initialPrompt) async {
    if (busy || closeLocked || composingNewDraft) return;
    if (imageProvider.isEmpty) {
      await loadImageSettings();
      if (!mounted) return;
      if (imageProvider.isEmpty) {
        setState(
          () => error = 'Image settings are unavailable. Use Change to reconnect before generating.',
        );
        return;
      }
    }
    composingNewDraft = true;
    bool? completed;
    try {
      completed = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (_) => SocialGenerateDialog(
          gateway: api,
          initialPrompt: initialPrompt,
          initialImageProvider: imageProvider,
        ),
      );
    } finally {
      composingNewDraft = false;
    }
    if (completed == true && mounted) await run(() => load());
  }

  Future<void> shareDraft() async {
    if (draft == null || busy || closeLocked) return;
    // Snapshot prevents background refresh/slide changes from changing a handoff.
    final post = SocialSharePayload(
      caption: '${draft!['caption'] ?? ''}',
      images: List<Uint8List>.unmodifiable(
        carouselFrames.isNotEmpty ? carouselFrames : [?imageBytes],
      ),
    );
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => SocialShareDialog(
        gateway: api,
        post: post,
        initialPlatform: '${draft!['platform'] ?? 'Other'}',
      ),
    );
  }

  @override
  Widget build(BuildContext context) => SocialWorkspace(
    drafts: drafts,
    imageProvider: imageProvider,
    metaConfigured: metaConfigured,
    onChangeImageProvider: changeImageSettings,
    selectedDraft: draft,
    imageBytes: imageBytes,
    slideCount: carouselFrames.length,
    slideImages: carouselFrames,
    selectedSlide: selectedSlide,
    onSelectSlide: (index) {
      if (index < 0 || index >= carouselFrames.length || busy) return;
      setState(() {
        selectedSlide = index;
        imageBytes = carouselFrames[index];
      });
    },
    error: error,
    busy: busy || closeLocked,
    hasMore: nextCursor != null,
    onLoadMore: () => run(() => load(more: true)),
    onSelectDraft: switchDraft,
    onDraftAction: performDraftAction,
    onCopy: copyCaption,
    onShare: shareDraft,
    onExportImage: imageBytes == null
        ? null
        : () => run(() async {
            await api.saveSocialImage(imageBytes!);
          }),
    onDelete: deleteDraft,
    onGenerate: openGenerate,
    onRecover: recover,
    onAcknowledge: acknowledge,
    imageInvalid: imageInvalid,
  );
}
