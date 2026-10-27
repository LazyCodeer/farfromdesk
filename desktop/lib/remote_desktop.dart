import 'dart:async';

import 'package:flutter/material.dart';
import 'package:livekit_client/livekit_client.dart';

import 'gateway.dart';

import 'package:flutter_webrtc/flutter_webrtc.dart' show DesktopCapturerSource;

class RemoteDesktopPage extends StatefulWidget {
  final Gateway gateway;
  const RemoteDesktopPage({super.key, required this.gateway});
  @override
  State<RemoteDesktopPage> createState() => _RemoteDesktopPageState();
}

class _RemoteDesktopPageState extends State<RemoteDesktopPage> {
  final password = TextEditingController(),
      confirmation = TextEditingController();
  Map<String, dynamic> status = {};
  String? error;
  bool busy = false;
  Room? room;
  LocalVideoTrack? track;
  @override
  void initState() {
    super.initState();
    unawaited(refresh());
  }

  Future<void> refresh() async {
    try {
      final s = await widget.gateway.get('/api/remote-desktop');
      if (mounted) setState(() => status = s);
    } catch (_) {
      if (mounted) {
        setState(() => error = 'Remote Desktop is unavailable in this build.');
      }
    }
  }

  Future<void> perform(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
      await refresh();
    } catch (_) {
      if (mounted) {
        setState(
          () => error = 'Could not complete this step. Check the connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> savePassword() async {
    if (password.text.length < 12 || password.text != confirmation.text) {
      setState(
        () => error =
            'Use at least 12 characters and enter the same password twice.',
      );
      return;
    }
    await perform(() async {
      await stop();
      await widget.gateway.post('/api/remote-desktop', {
        'action': 'password',
        'password': password.text,
      });
      password.clear();
      confirmation.clear();
    });
  }

  Future<void> start() async {
    await perform(() async {
      final credentials = await widget.gateway.post('/api/remote-desktop', {
        'action': 'host-token',
      });
      if (!mounted) return;
      final source = await showDialog<DesktopCapturerSource>(
        context: context,
        builder: (_) => ScreenSelectDialog(),
      );
      if (source == null) return;
      Room? next;
      LocalVideoTrack? video;
      try {
        video = await LocalVideoTrack.createScreenShareTrack(
          ScreenShareCaptureOptions(sourceId: source.id, maxFrameRate: 15),
        );
        next = Room();
        await next.connect(
          credentials['url'] as String,
          credentials['token'] as String,
        );
        await next.localParticipant!.publishVideoTrack(video);
        await widget.gateway.post('/api/remote-desktop', {
          'action': 'host-ready',
          'ready': true,
        });
        if (mounted) {
          setState(() {
            room = next;
            track = video;
          });
        }
      } catch (_) {
        await video?.stop();
        await next?.disconnect();
        await widget.gateway.post('/api/remote-desktop', {
          'action': 'host-ready',
          'ready': false,
        });
        rethrow;
      }
    });
  }

  Future<void> stop() async {
    final oldRoom = room, oldTrack = track;
    room = null;
    track = null;
    await oldTrack?.stop();
    await oldRoom?.disconnect();
    await widget.gateway.post('/api/remote-desktop', {'action': 'stop'});
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    password.dispose();
    confirmation.dispose();
    unawaited(track?.stop() ?? Future.value());
    unawaited(room?.disconnect() ?? Future.value());
    unawaited(
      widget.gateway
          .post('/api/remote-desktop', {'action': 'stop'})
          .then((_) {})
          .catchError((_) {}),
    );
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Remote Desktop')),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const Text(
          'Access your Mac when you need it',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 12),
        const Text(
          'Set a password here. A new connection asks for it each time. There is no fixed session time limit while your Mac is awake and unlocked. Stop or a lock ends access.',
        ),
        const SizedBox(height: 20),
        Text(
          status['passwordSet'] == true
              ? 'Password saved'
              : 'Set your remote access password',
        ),
        TextField(
          key: const Key('remote-password'),
          controller: password,
          obscureText: true,
          enableSuggestions: false,
          autocorrect: false,
          decoration: const InputDecoration(
            labelText: 'Password, at least 12 characters',
          ),
        ),
        TextField(
          key: const Key('remote-password-confirm'),
          controller: confirmation,
          obscureText: true,
          enableSuggestions: false,
          autocorrect: false,
          decoration: const InputDecoration(labelText: 'Confirm password'),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: busy ? null : savePassword,
          child: const Text('Save password'),
        ),
        SwitchListTile(
          title: const Text('Make this Mac available'),
          subtitle: const Text(
            'A password is still required for every new connection.',
          ),
          value: status['enabled'] == true,
          onChanged: busy || status['passwordSet'] != true
              ? null
              : (value) => perform(() async {
                  if (!value) {
                    await stop();
                  } else {
                    await widget.gateway.post('/api/remote-desktop', {
                      'action': 'enable',
                      'enabled': true,
                    });
                  }
                }),
        ),
        Text(status['message']?.toString() ?? 'Checking Remote Desktop…'),
        if (error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(
              error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed:
              busy ||
                  status['enabled'] != true ||
                  status['transportConfigured'] != true ||
                  room != null
              ? null
              : start,
          child: const Text('Choose screen and start local video test'),
        ),
        OutlinedButton(
          onPressed: () async {
            try {
              await stop();
              await refresh();
            } catch (_) {
              if (mounted) {
                setState(
                  () => error = 'Video stopped locally. Server disconnect could not be confirmed.',
                );
              }
            }
          },
          child: const Text('Stop remote access'),
        ),
        TextButton(onPressed: refresh, child: const Text('Refresh status')),
        if (track != null)
          SizedBox(height: 400, child: VideoTrackRenderer(track!)),
        const SizedBox(height: 16),
        const Text(
          'Development trial: LiveKit viewing only. Phone routing, automatic locked-state integration and streamed pointer/keyboard control are not enabled in this build.',
        ),
      ],
    ),
  );
}
