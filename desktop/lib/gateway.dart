import 'dart:typed_data';

import 'updates.dart';
import 'social_share.dart';

typedef SocialGenerator = Future<Map<String, dynamic>> Function(
  String kind,
  Map<String, dynamic> input,
);

/// The only pages the voice setup may open: each provider's key console.
final voiceSignupUrls = {
  Uri.parse('https://console.deepgram.com/'),
  Uri.parse('https://www.assemblyai.com/dashboard/'),
  Uri.parse('https://dev.meta.ai/'),
};

abstract class Gateway {
  Future<Map<String, dynamic>> get(String path);
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> data);
  Future<String?> chooseFile(String label);
  bool get canShareSocialNatively => false;
  Future<void> openSocialPlatform(String platform, String caption) async =>
      throw UnsupportedError('Platform opening is unavailable.');
  Future<bool> exportSocialPost(SocialSharePayload post) async => false;
  Future<bool> shareSocialPost(SocialSharePayload post) async => false;
  Future<bool> saveSocialImage(Uint8List bytes) async => false;
  Future<SocialGenerator> prepareSocialGenerator() async => throw StateError(
    'Meta generation is only available in FarFromDesk Local.',
  );
  Future<Map<String, dynamic>> readDocument(String path);
  Future<bool> startupEnabled();
  Future<void> setStartup(bool enabled);
  Future<void> previewFlow(String flow) async {}
  Future<void> reportReady() async {}
  Future<Map<String, dynamic>?> updateOutcome() async => null;
  Future<UpdateCheck> checkUpdates({bool manual = false}) async =>
      const UpdateCheck();
  Future<UpdatePreferences> loadUpdatePreferences() async =>
      UpdatePreferences();
  Future<void> saveUpdatePreferences(UpdatePreferences prefs) async {}
  Future<void> openReleasePage(Uri uri) async {}
  Future<void> openTelegram(Uri uri) async {}
  Future<void> openVoiceSignup(Uri uri) async {}
  bool get canInstallUpdate => false;
  Future<void> installUpdate(
    AppRelease release,
    void Function(Map<String, dynamic>) progress,
  ) async {
    throw UnsupportedError(
      'Automatic installation is not available on this platform.',
    );
  }

  void closeUpdates() {}
  String get platform;
  String get computerName => '';
  bool get localEmail => false;
  bool get preview => false;
  int get initialScreen => 0;
}
