import 'package:flutter/material.dart';

import 'gateway.dart';
import 'local_email_panel.dart';

class _EmailApi implements LocalEmailGateway {
  _EmailApi(this.api, this.accountId);
  final Gateway api;
  final String accountId;
  List<String> _to(String value) =>
      value.split(',').map((x) => x.trim()).where((x) => x.isNotEmpty).toList();
  EmailDraft _draft(Map d) => EmailDraft(
    id: d['id'],
    revision: d['revision'],
    digest: d['digest'],
    from: d['from'],
    to: List<String>.from(d['to']).join(', '),
    subject: d['subject'],
    body: d['body'],
  );
  Future<Map<String, dynamic>> _post(
    String action,
    Map<String, dynamic> values,
  ) => api.post('/api/local-email', {
    'action': action,
    'accountId': accountId,
    ...values,
  });
  @override
  Future<List<EmailMessage>> inbox() async {
    final result = await _post('inbox', {});
    return (result['messages'] as List)
        .map(
          (m) => EmailMessage(
            uid: m['uid'],
            from: m['from'],
            sourceDigest: m['sourceDigest'],
            subject: m['subject'],
            text: m['text'],
            plainTextAvailable: m['plainTextAvailable'],
            attachments: m['attachments'],
          ),
        )
        .toList();
  }

  @override
  Future<String> summarize() async => (await _post('summary', {}))['summary'];
  @override
  Future<EmailDraft> prepareReply(
    EmailMessage source,
    String to,
    String subject,
    String instruction,
    String tone,
  ) async => _draft(
    await _post('prepare', {
      'uid': source.uid,
      'input': {
        'to': _to(to),
        'subject': subject,
        'instruction': instruction,
        'tone': tone,
        'sourceDigest': source.sourceDigest,
      },
    }),
  );
  @override
  Future<EmailDraft> saveDraft(
    EmailDraft draft,
    String to,
    String subject,
    String body,
  ) async => _draft(
    await _post('save', {
      'draftId': draft.id,
      'input': {'to': _to(to), 'subject': subject, 'body': body},
    }),
  );
  @override
  Future<String> approveAndSend(EmailDraft reviewed) async =>
      (await _post('send', {
        'draftId': reviewed.id,
        'revision': reviewed.revision,
        'digest': reviewed.digest,
      }))['status'];
}

class LocalEmailScreen extends StatefulWidget {
  const LocalEmailScreen({super.key, required this.gateway});
  final Gateway gateway;
  @override
  State<LocalEmailScreen> createState() => _LocalEmailScreenState();
}

class _LocalEmailScreenState extends State<LocalEmailScreen> {
  Map<String, dynamic>? status;
  String? selected, error;
  bool working = false, setup = false;
  final address = TextEditingController(),
      imapHost = TextEditingController(text: 'imap.gmail.com'),
      imapPort = TextEditingController(text: '993'),
      imapUser = TextEditingController(),
      imapPassword = TextEditingController(),
      smtpHost = TextEditingController(text: 'smtp.gmail.com'),
      smtpPort = TextEditingController(text: '465'),
      smtpUser = TextEditingController(),
      smtpPassword = TextEditingController();
  List<Map<String, dynamic>> get accounts =>
      (status?['accounts'] as List? ?? [])
          .map((x) => Map<String, dynamic>.from(x))
          .toList();
  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void dispose() {
    for (final c in [
      address,
      imapHost,
      imapPort,
      imapUser,
      imapPassword,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPassword,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> load() async {
    try {
      final s = await widget.gateway.get('/api/local-email');
      if (!mounted) return;
      setState(() {
        status = s;
        if (!accounts.any(
          (a) => a['id'] == selected && a['status'] == 'configured',
        )) {
          selected = accounts
              .where((a) => a['status'] == 'configured')
              .firstOrNull?['id'];
        }
      });
    } catch (_) {
      if (mounted) setState(() => error = 'Email status is unavailable.');
    }
  }

  Future<void> run(Future<void> Function() operation) async {
    if (working) return;
    setState(() {
      working = true;
      error = null;
    });
    try {
      await operation();
      await load();
    } catch (_) {
      if (mounted) {
        setState(
          () => error = 'Email setup could not be completed. Check the settings and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => working = false);
    }
  }

  Future<void> configure() => run(() async {
    try {
      await widget.gateway.post('/api/local-email', {
        'action': 'configure',
        'account': {
          'label': address.text,
          'address': address.text,
          'imap': {
            'host': imapHost.text,
            'port': int.tryParse(imapPort.text),
            'username': imapUser.text.isEmpty ? address.text : imapUser.text,
          },
          'smtp': {
            'host': smtpHost.text,
            'port': int.tryParse(smtpPort.text),
            'username': smtpUser.text.isEmpty ? address.text : smtpUser.text,
          },
        },
        'credentials': {
          'imapPassword': imapPassword.text,
          'smtpPassword': smtpPassword.text,
        },
      });
      setup = false;
    } finally {
      imapPassword.clear();
      smtpPassword.clear();
    }
  });
  Future<void> disconnect(String id) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Disconnect email?'),
        content: const Text(
          'Saved drafts are removed and Keychain credentials are deleted when available.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Disconnect'),
          ),
        ],
      ),
    );
    if (confirm == true && mounted) {
      await run(
        () => widget.gateway
            .post('/api/local-email', {'action': 'disconnect', 'accountId': id})
            .then((_) {}),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (status == null) {
      return Center(
        child: error == null ? const CircularProgressIndicator() : Text(error!),
      );
    }
    if (status!['available'] != true) {
      return const Center(
        child: Text(
          'Email is unavailable. Check that the Local email helpers are installed and Keychain is accessible.',
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (error != null) Text(error!),
        if (status!['credentialsRecoveryRequired'] == true)
          const Text(
            'Some credential writes could not be confirmed. Restart your Mac, then reopen Local. If cleanup still cannot finish, contact support.',
          ),
        if (status!['credentialsCleanupPending'] == true)
          Row(
            children: [
              const Text('Credential cleanup is pending.'),
              TextButton(
                onPressed: working
                    ? null
                    : () => run(
                        () => widget.gateway
                            .post('/api/local-email', {'action': 'cleanup'})
                            .then((_) {}),
                      ),
                child: const Text('Retry cleanup'),
              ),
            ],
          ),
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 12,
          children: [
            for (final a in accounts)
              ChoiceChip(
                label: Text(
                  '${a['address']} · ${a['status'] == 'configured' ? 'saved, unverified' : a['status']}',
                ),
                selected: selected == a['id'],
                onSelected: a['status'] != 'configured'
                    ? null
                    : (_) => setState(() => selected = a['id']),
              ),
            TextButton(
              onPressed: working ? null : () => setState(() => setup = !setup),
              child: Text(setup ? 'Close setup' : 'Connect account'),
            ),
            if (selected != null)
              TextButton(
                onPressed: working ? null : () => disconnect(selected!),
                child: const Text('Disconnect'),
              ),
          ],
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text(
            'Allow email content to be sent to Meta for summaries and drafts',
          ),
          subtitle: const Text(
            'Requires Meta Brain enabled. You can turn this off at any time.',
          ),
          value: status!['cloudConsent'] == true,
          onChanged: working
              ? null
              : (value) => run(
                  () => widget.gateway
                      .post('/api/local-email', {
                        'action': 'consent',
                        'enabled': value,
                      })
                      .then((_) {}),
                ),
        ),
        if (setup)
          Expanded(
            child: ListView(
              children: [
                const Text(
                  'Gmail app passwords are available only for eligible accounts. OAuth and STARTTLS are not supported. Settings are saved without checking login.',
                ),
                TextField(
                  controller: address,
                  decoration: const InputDecoration(labelText: 'Email address'),
                ),
                TextField(
                  controller: imapHost,
                  decoration: const InputDecoration(
                    labelText: 'IMAP host (implicit TLS)',
                  ),
                ),
                TextField(
                  controller: imapPort,
                  decoration: const InputDecoration(labelText: 'IMAP port'),
                ),
                TextField(
                  controller: imapUser,
                  decoration: const InputDecoration(
                    labelText: 'IMAP username (optional; defaults to email)',
                  ),
                ),
                TextField(
                  controller: imapPassword,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: const InputDecoration(
                    labelText: 'IMAP app password',
                  ),
                ),
                TextField(
                  controller: smtpHost,
                  decoration: const InputDecoration(
                    labelText: 'SMTP host (implicit TLS)',
                  ),
                ),
                TextField(
                  controller: smtpPort,
                  decoration: const InputDecoration(labelText: 'SMTP port'),
                ),
                TextField(
                  controller: smtpUser,
                  decoration: const InputDecoration(
                    labelText: 'SMTP username (optional; defaults to email)',
                  ),
                ),
                TextField(
                  controller: smtpPassword,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: const InputDecoration(
                    labelText: 'SMTP app password',
                  ),
                ),
                const Text(
                  'Passwords are stored in macOS Keychain. Custom servers must resolve only to public IP addresses.',
                ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: FilledButton(
                    onPressed: working ? null : configure,
                    child: const Text('Save account'),
                  ),
                ),
              ],
            ),
          )
        else if (selected == null)
          const Expanded(
            child: Center(
              child: Text('Connect an email account to get started.'),
            ),
          )
        else
          Expanded(
            child: LocalEmailPanel(
              key: ValueKey(selected),
              gateway: _EmailApi(widget.gateway, selected!),
            ),
          ),
      ],
    );
  }
}
