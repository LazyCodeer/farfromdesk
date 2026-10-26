import 'updates.dart';

/// The only pages the voice setup may open: each provider's key console.
final voiceSignupUrls = {
  Uri.parse('https://console.deepgram.com/'),
  Uri.parse('https://www.assemblyai.com/dashboard/'),
};

abstract class Gateway {
  Future<Map<String, dynamic>> get(String path);
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> data);
  Future<String?> chooseFile(String label);
  Future<Map<String, dynamic>> readDocument(String path);
  Future<bool> startupEnabled();
  Future<void> setStartup(bool enabled);
  Future<void> previewFlow(String flow) async {}
  Future<void> reportReady() async {}
  Future<UpdateCheck> checkUpdates({bool manual = false}) async =>
      const UpdateCheck();
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
  bool get preview => false;
  int get initialScreen => 0;
}
