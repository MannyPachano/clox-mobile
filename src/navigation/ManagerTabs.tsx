import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { Ionicons } from "@expo/vector-icons";
import {
  NavigationContainer,
  DefaultTheme,
  type Theme,
} from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";

import type { Session } from "@supabase/supabase-js";

import { getManagerSummary } from "../api";
import { ApprovalsScreen } from "../screens/ApprovalsScreen";
import { ClockScreen } from "../screens/ClockScreen";
import { RosterScreen } from "../screens/RosterScreen";
import { ScheduleScreen } from "../screens/ScheduleScreen";
import { getAccessToken } from "../supabase";
import { lightColors } from "../theme";

const Tab = createBottomTabNavigator();

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Clock: "time-outline",
  Roster: "people-outline",
  Schedule: "calendar-outline",
  Approvals: "checkmark-done-outline",
};

const navTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: lightColors.bg,
    card: lightColors.surface,
    text: lightColors.text,
    border: lightColors.border,
    primary: lightColors.accent,
  },
};

/**
 * Manager shell: a bottom-tab navigator. The "Clock" tab is the same screen
 * employees use (managers clock in too); Roster + Approvals are manager-only.
 * Employees never see this — App renders ClockScreen directly for them.
 */
export function ManagerTabs({
  session,
  onSignOut,
}: {
  session: Session;
  onSignOut: () => void;
}) {
  const [pending, setPending] = useState(0);

  // Poll a light summary so the Approvals tab shows a pending-count badge.
  useEffect(() => {
    let active = true;
    const fetchSummary = async () => {
      const t = await getAccessToken();
      if (!t) return;
      try {
        const res = await getManagerSummary(t);
        if (active && res.ok) {
          setPending(res.data.pendingApprovals + res.data.pendingLeave);
        }
      } catch {
        // best-effort — the badge just won't update on a blip
      }
    };
    void fetchSummary();
    const id = setInterval(fetchSummary, 60000);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void fetchSummary();
    });
    return () => {
      active = false;
      clearInterval(id);
      sub.remove();
    };
  }, []);

  return (
    <NavigationContainer theme={navTheme}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: lightColors.accent,
          tabBarInactiveTintColor: lightColors.textMuted,
          tabBarStyle: {
            backgroundColor: lightColors.surface,
            borderTopColor: lightColors.border,
          },
          tabBarIcon: ({ color, size }) => (
            <Ionicons
              name={ICONS[route.name] ?? "ellipse-outline"}
              size={size}
              color={color}
            />
          ),
        })}
      >
        <Tab.Screen name="Clock">
          {() => <ClockScreen session={session} onSignOut={onSignOut} />}
        </Tab.Screen>
        <Tab.Screen name="Roster" component={RosterScreen} />
        <Tab.Screen name="Schedule" component={ScheduleScreen} />
        <Tab.Screen
          name="Approvals"
          component={ApprovalsScreen}
          options={{ tabBarBadge: pending > 0 ? pending : undefined }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
