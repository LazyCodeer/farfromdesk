import 'package:flutter/material.dart';

/// Host adapter must authenticate the desktop owner and validate the reviewed
/// revision and digest independently. This widget is not a send authority.
abstract class LocalEmailGateway {
  Future<List<EmailMessage>> inbox();
  Future<String> summarize();
  Future<EmailDraft> prepareReply(
    EmailMessage source,
    String to,
    String subject,
    String instruction,
    String tone,
  );
  Future<EmailDraft> saveDraft(
    EmailDraft draft,
    String to,
    String subject,
    String body,
  );
  Future<String> approveAndSend(EmailDraft reviewed);
}

class EmailMessage {
  const EmailMessage({
    required this.uid,
    required this.from,
    required this.sourceDigest,
    required this.subject,
    required this.text,
    required this.plainTextAvailable,
    this.attachments = 0,
  });
  final int uid;
  final String from, sourceDigest, subject, text;
  final bool plainTextAvailable;
  final int attachments;
}

class EmailDraft {
  const EmailDraft({
    required this.id,
    required this.revision,
    required this.digest,
    required this.from,
    required this.to,
    required this.subject,
    required this.body,
  });
  final String id, revision, digest, from, to, subject, body;
}

/// Reusable panel only; no production routes are registered by this file.
class LocalEmailPanel extends StatefulWidget {
  const LocalEmailPanel({super.key, required this.gateway});
  final LocalEmailGateway gateway;
  @override
  State<LocalEmailPanel> createState() => _LocalEmailPanelState();
}

class _LocalEmailPanelState extends State<LocalEmailPanel> {
  List<EmailMessage> messages = [];
  EmailMessage? selected;
  EmailDraft? draft;
  String? summary, notice;
  bool busy = false;
  final to = TextEditingController(),
      subject = TextEditingController(),
      body = TextEditingController(),
      instruction = TextEditingController(),
      tone = TextEditingController();
  @override
  void initState() {
    super.initState();
    refresh();
  }

  @override
  void dispose() {
    to.dispose();
    subject.dispose();
    body.dispose();
    instruction.dispose();
    tone.dispose();
    super.dispose();
  }

  Future<void> run(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      notice = null;
    });
    try {
      await action();
    } catch (_) {
      if (mounted) {
        setState(
          () => notice = 'Could not complete the email request. Check the account and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> refresh() => run(() async {
    final result = await widget.gateway.inbox();
    if (!mounted) return;
    setState(() {
      messages = result;
      selected = null;
      draft = null;
      summary = null;
    });
  });
  void select(EmailMessage m) {
    setState(() {
      selected = m;
      draft = null;
      to.text = m.from;
      subject.text = 'Re: ${m.subject}';
      body.clear();
    });
  }

  Future<void> prepare() => run(() async {
    final source = selected;
    if (source == null || !source.plainTextAvailable) return;
    final result = await widget.gateway.prepareReply(
      source,
      to.text,
      subject.text,
      instruction.text,
      tone.text,
    );
    if (!mounted) return;
    setState(() {
      draft = result;
      to.text = result.to;
      subject.text = result.subject;
      body.text = result.body;
    });
  });
  Future<void> review() async {
    if (draft == null) return;
    EmailDraft? saved;
    await run(() async {
      saved = await widget.gateway.saveDraft(
        draft!,
        to.text,
        subject.text,
        body.text,
      );
      if (mounted) setState(() => draft = saved);
    });
    if (!mounted || saved == null) return;
    final reviewed = saved!;
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Review and send?'),
        content: SingleChildScrollView(
          child: SelectableText(
            'From: ${reviewed.from}\nTo: ${reviewed.to}\nSubject: ${reviewed.subject}\n\n${reviewed.body}',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Approve and send'),
          ),
        ],
      ),
    );
    if (approved != true || !mounted) return;
    await run(() async {
      String status;
      try {
        status = await widget.gateway.approveAndSend(reviewed);
      } catch (_) {
        status = 'uncertain';
      }
      if (!mounted) return;
      setState(() {
        notice = status == 'sent'
            ? 'The mail server accepted the message. Delivery is not confirmed.'
            : status == 'cancelled'
            ? 'Send cancelled.'
            : 'Send outcome is uncertain. Check your mail before trying again.';
        if (status != 'cancelled') draft = null;
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    final m = selected;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Email', style: Theme.of(context).textTheme.headlineSmall),
            const Spacer(),
            TextButton(
              onPressed: busy ? null : refresh,
              child: const Text('Refresh inbox'),
            ),
          ],
        ),
        const Text(
          'Read-only inbox. Summarizing or drafting shares email content with your configured AI provider.',
        ),
        if (notice != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: SelectableText(notice!),
          ),
        if (busy) const LinearProgressIndicator(),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final list = ListView(
                children: [
                  for (final item in messages)
                    ListTile(
                      title: Text(item.subject),
                      subtitle: Text(item.from),
                      selected: item == m,
                      onTap: busy ? null : () => select(item),
                    ),
                  if (messages.isEmpty)
                    const ListTile(title: Text('No messages to show.')),
                  TextButton(
                    onPressed: busy || messages.isEmpty
                        ? null
                        : () => run(() async {
                            final value = await widget.gateway.summarize();
                            if (mounted) setState(() => summary = value);
                          }),
                    child: const Text('Summarize inbox'),
                  ),
                  if (summary != null) SelectableText(summary!),
                ],
              );
              final detail = m == null
                  ? const Center(child: Text('Select a message to read it.'))
                  : ListView(
                      children: [
                        Text(
                          m.subject,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        Text('From: ${m.from}'),
                        const SizedBox(height: 16),
                        SelectableText(
                          m.plainTextAvailable
                              ? m.text
                              : 'Plain text is unavailable for this message.',
                        ),
                        if (m.attachments > 0)
                          Text(
                            '${m.attachments} attachment(s) are not opened.',
                          ),
                        const Divider(height: 32),
                        const Text('Prepare a reply'),
                        TextField(
                          controller: to,
                          decoration: const InputDecoration(labelText: 'To'),
                        ),
                        TextField(
                          controller: subject,
                          decoration: const InputDecoration(
                            labelText: 'Subject',
                          ),
                        ),
                        TextField(
                          controller: instruction,
                          decoration: const InputDecoration(
                            labelText: 'What should the reply say?',
                          ),
                        ),
                        TextField(
                          controller: tone,
                          decoration: const InputDecoration(
                            labelText: 'Tone or writing guidance',
                          ),
                        ),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton(
                            onPressed: busy || !m.plainTextAvailable
                                ? null
                                : prepare,
                            child: const Text('Prepare reply'),
                          ),
                        ),
                        if (draft != null) ...[
                          TextField(
                            controller: body,
                            maxLines: 8,
                            decoration: const InputDecoration(
                              labelText: 'Reply draft',
                            ),
                          ),
                          const SizedBox(height: 12),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: FilledButton(
                              onPressed: busy ? null : review,
                              child: const Text('Review send'),
                            ),
                          ),
                        ],
                      ],
                    );
              if (constraints.maxWidth < 700) {
                return ListView(
                  children: [
                    SizedBox(height: 240, child: list),
                    SizedBox(height: 600, child: detail),
                  ],
                );
              }
              return Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(width: 260, child: list),
                  const VerticalDivider(width: 32),
                  Expanded(child: detail),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}
