import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Text } from "react-native";
import { useAuth } from "../state/AuthContext";
import { DeviceProvider } from "../state/DeviceContext";
import { LoginScreen } from "../screens/LoginScreen";
import { RegisterScreen } from "../screens/RegisterScreen";
import { DashboardScreen } from "../screens/DashboardScreen";
import { SleepScreen } from "../screens/SleepScreen";
import { DevicesScreen } from "../screens/DevicesScreen";
import { AlarmsScreen } from "../screens/AlarmsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { PairingScreen } from "../screens/PairingScreen";
import { lightTheme } from "../theme";

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

export type MainTabParamList = {
  Dashboard: undefined;
  Sleep: undefined;
  Devices: undefined;
  Alarms: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Main: undefined;
  Pairing: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
const RootStack = createNativeStackNavigator<RootStackParamList>();

const TAB_ICONS: Record<keyof MainTabParamList, string> = {
  Dashboard: "◆",
  Sleep: "☾",
  Devices: "◈",
  Alarms: "◷",
  Settings: "⚙",
};

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: lightTheme.accent,
        tabBarInactiveTintColor: lightTheme.textMuted,
        tabBarIcon: () => <Text style={{ fontSize: 18 }}>{TAB_ICONS[route.name as keyof MainTabParamList]}</Text>,
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Sleep" component={SleepScreen} />
      <Tab.Screen name="Devices" component={DevicesScreen} />
      <Tab.Screen name="Alarms" component={AlarmsScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Register" component={RegisterScreen} />
    </AuthStack.Navigator>
  );
}

function AppNavigator() {
  return (
    <DeviceProvider>
      <RootStack.Navigator>
        <RootStack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
        <RootStack.Screen name="Pairing" component={PairingScreen} options={{ title: "Pair a device", presentation: "modal" }} />
      </RootStack.Navigator>
    </DeviceProvider>
  );
}

export function RootNavigator() {
  const { user, loading } = useAuth();
  if (loading) return null;

  return <NavigationContainer>{user ? <AppNavigator /> : <AuthNavigator />}</NavigationContainer>;
}
