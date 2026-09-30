import { registerRootComponent } from "expo";
import { AppRegistry } from "react-native";

import App from "./App";
import { installShiftActions, runShiftActionTask } from "./src/shift-actions";
import { SHIFT_ACTION_TASK_NAME } from "./src/shift-surface";

// Lock Screen, widget and notification taps (src/shift-actions.ts), set up
// before the root component so they work on every start: a normal launch, an
// iOS background launch for a Live Activity or widget button (nothing shows on
// screen), and Android's headless task, which every notification action
// starts: in the running app, or without a screen when the app is not running
// (AppRegistry runs the task, not the app). The onTap event, when the app
// listens, joins the same pass.
installShiftActions();
AppRegistry.registerHeadlessTask(SHIFT_ACTION_TASK_NAME, () => runShiftActionTask);

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
// and sets up the Expo environment for both Expo Go and native builds.
registerRootComponent(App);
