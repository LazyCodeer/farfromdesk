part of 'app.dart';

// Decorative artwork mirrors the editable Overview mockup. It represents the
// type of work, never a fabricated trend or a value derived from sample data.
enum _MetricArtKind { requests, answered, progress, attention }

class _OverviewMetricPainter extends CustomPainter {
  const _OverviewMetricPainter(this.kind, {this.attention = false});

  final _MetricArtKind kind;
  final bool attention;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 88, size.height / 72);

    void panel(
      double x,
      double y,
      double w,
      double h,
      double radius,
      Color fill,
      Color border,
    ) {
      final shape = RRect.fromRectAndRadius(
        Rect.fromLTWH(x, y, w, h),
        Radius.circular(radius),
      );
      canvas.drawRRect(shape, Paint()..color = fill);
      canvas.drawRRect(
        shape,
        Paint()
          ..color = border
          ..style = PaintingStyle.stroke,
      );
    }

    void line(Path path, Color color, [double width = 1.6]) {
      canvas.drawPath(
        path,
        Paint()
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = width
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round,
      );
    }

    void dot(double x, double y, double radius, Color color) =>
        canvas.drawCircle(Offset(x, y), radius, Paint()..color = color);

    switch (kind) {
      case _MetricArtKind.requests:
        panel(
          12,
          10,
          50,
          39,
          7,
          const Color(0xff19191a),
          const Color(0xff39393a),
        );
        line(
          Path()
            ..moveTo(22, 21)
            ..lineTo(45, 21)
            ..moveTo(22, 28)
            ..lineTo(38, 28),
          const Color(0xff6f7071),
        );
        final tail = Path()
          ..moveTo(17, 49)
          ..lineTo(14, 56)
          ..lineTo(26, 49)
          ..close();
        canvas.drawPath(tail, Paint()..color = const Color(0xff19191a));
        line(tail, const Color(0xff39393a), 1);
        panel(
          38,
          30,
          34,
          26,
          6,
          const Color(0xff28211d),
          const Color(0xffa15b40),
        );
        line(
          Path()
            ..moveTo(46, 39)
            ..lineTo(64, 39)
            ..moveTo(46, 45)
            ..lineTo(58, 45),
          const Color(0xffd68d6b),
          1.5,
        );
        dot(68, 20, 3, const Color(0xffd68d6b));
      case _MetricArtKind.answered:
        panel(
          12,
          11,
          50,
          39,
          7,
          const Color(0xff191b1a),
          const Color(0xff37413d),
        );
        line(
          Path()
            ..moveTo(22, 22)
            ..lineTo(45, 22)
            ..moveTo(22, 29)
            ..lineTo(38, 29),
          const Color(0xff71867c),
        );
        final tail = Path()
          ..moveTo(17, 50)
          ..lineTo(14, 57)
          ..lineTo(26, 50)
          ..close();
        canvas.drawPath(tail, Paint()..color = const Color(0xff191b1a));
        line(tail, const Color(0xff37413d), 1);
        panel(
          44,
          29,
          29,
          27,
          7,
          const Color(0xff1c3028),
          const Color(0xff4b8b6d),
        );
        line(
          Path()
            ..moveTo(51, 42)
            ..lineTo(56, 47)
            ..lineTo(66, 36),
          const Color(0xff78c99c),
          2,
        );
        line(
          Path()
            ..moveTo(68, 16)
            ..lineTo(73, 16)
            ..moveTo(70.5, 13.5)
            ..lineTo(70.5, 18.5),
          const Color(0xff639f7d),
          1.4,
        );
      case _MetricArtKind.progress:
        panel(
          12,
          12,
          62,
          44,
          7,
          const Color(0xff1b1c1d),
          const Color(0xff42484c),
        );
        line(
          Path()
            ..moveTo(12, 23)
            ..lineTo(74, 23),
          const Color(0xff42484c),
          1,
        );
        dot(20, 17.5, 1.5, const Color(0xff87959b));
        dot(25, 17.5, 1.5, const Color(0xff5f696e));
        line(
          Path()
            ..moveTo(23, 34)
            ..lineTo(28, 38)
            ..lineTo(23, 42)
            ..moveTo(33, 42)
            ..lineTo(45, 42),
          const Color(0xffacb9bd),
          1.8,
        );
        dot(59, 42, 2, const Color(0xff91a6a8));
        dot(65, 42, 2, const Color(0xff697c7e));
        dot(71, 42, 2, const Color(0xff465758));
      case _MetricArtKind.attention:
        panel(
          16,
          10,
          48,
          46,
          7,
          const Color(0xff1d1c19),
          const Color(0xff49443a),
        );
        line(
          Path()
            ..moveTo(25, 22)
            ..lineTo(50, 22)
            ..moveTo(25, 29)
            ..lineTo(42, 29)
            ..moveTo(25, 36)
            ..lineTo(45, 36),
          const Color(0xff857d6e),
        );
        panel(
          45,
          34,
          28,
          25,
          7,
          attention ? const Color(0xff30271c) : const Color(0xff1c3028),
          attention ? const Color(0xffa08451) : const Color(0xff4b8b6d),
        );
        if (attention) {
          line(
            Path()
              ..moveTo(59, 40)
              ..lineTo(59, 47),
            const Color(0xffd0ad6b),
            2,
          );
          dot(59, 51, 1, const Color(0xffd0ad6b));
        } else {
          line(
            Path()
              ..moveTo(52, 46)
              ..lineTo(57, 51)
              ..lineTo(66, 41),
            const Color(0xff78c99c),
            2,
          );
        }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _OverviewMetricPainter oldDelegate) =>
      kind != oldDelegate.kind || attention != oldDelegate.attention;
}
