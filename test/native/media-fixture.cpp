// Isolated, silent Windows media source used only by the opt-in integration test.
#include <windows.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.h>
#include <winrt/Windows.Media.Core.h>
#include <winrt/Windows.Media.Playback.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>
#include <iostream>

using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Media;
using namespace Windows::Media::Core;
using namespace Windows::Media::Playback;
using namespace Windows::Storage;

int wmain(int argc, wchar_t** argv) {
  if (argc != 3 && argc != 4) return 2;
  init_apartment(apartment_type::multi_threaded);
  int result = 0;
  try {
    MediaPlayer player;
    player.Volume(0); player.IsLoopingEnabled(true);
    player.CommandManager().IsEnabled(false);
    auto controls = player.SystemMediaTransportControls();
    controls.IsEnabled(true);
    controls.IsPlayEnabled(true); controls.IsPauseEnabled(true);
    controls.IsNextEnabled(true); controls.IsPreviousEnabled(true);
    auto updater = controls.DisplayUpdater();
    updater.Type(MediaPlaybackType::Music);
    updater.MusicProperties().Title(argv[2]);
    updater.MusicProperties().Artist(L"SMTC 测试");
    if (argc == 4) updater.Thumbnail(Windows::Storage::Streams::RandomAccessStreamReference::CreateFromFile(StorageFile::GetFileFromPathAsync(argv[3]).get()));
    updater.Update();
    auto setTimeline = [controls](TimeSpan position) {
      SystemMediaTransportControlsTimelineProperties timeline;
      timeline.StartTime(TimeSpan{0}); timeline.MinSeekTime(TimeSpan{0});
      timeline.EndTime(std::chrono::seconds(60)); timeline.MaxSeekTime(std::chrono::seconds(60));
      timeline.Position(position); controls.UpdateTimelineProperties(timeline);
    };
    // Blocking is confined to the standalone fixture, never to the addon.
    player.Source(MediaSource::CreateFromStorageFile(StorageFile::GetFileFromPathAsync(argv[1]).get()));
    player.Play(); controls.PlaybackStatus(MediaPlaybackStatus::Playing); setTimeline(TimeSpan{0});
    std::cout << "ready" << std::endl;
    // Test-only input simulates actions inside this isolated player.
    std::string line;
    while (std::getline(std::cin, line) && line != "stop") {
      if (line == "pause") {
        player.Pause(); controls.PlaybackStatus(MediaPlaybackStatus::Paused);
      } else if (line == "play") {
        player.Play(); controls.PlaybackStatus(MediaPlaybackStatus::Playing);
      } else if (line == "track") {
        updater.MusicProperties().Title(hstring(argv[2]) + L" changed");
        updater.MusicProperties().TrackNumber(1); updater.Update();
      } else if (line == "position") {
        player.PlaybackSession().Position(std::chrono::seconds(5));
        setTimeline(std::chrono::seconds(5));
      }
    }
    player.Pause(); controls.PlaybackStatus(MediaPlaybackStatus::Closed); controls.IsEnabled(false);
    player.Close();
  } catch (hresult_error const& error) {
    std::cerr << "fixture HRESULT: " << std::hex << static_cast<unsigned>(error.code().value) << std::endl;
    result = 1;
  }
  uninit_apartment();
  return result;
}
