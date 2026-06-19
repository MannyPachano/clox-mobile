import { Component, type ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { reportError } from "../error-reporting";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. A render-phase throw anywhere in the tree would
 * otherwise abort the whole app in a release (Hermes) build — SIGABRT, no
 * recovery, the OS just closes Clox. This catches it, reports it to the
 * backend, and shows a recover screen with a "Try again" instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: unknown) {
    reportError(error, "react-error-boundary");
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            Clox ran into an unexpected error. You can try again. If it keeps
            happening, email support@getclox.com and we will help.
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={this.handleReset}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    backgroundColor: "#f3efe7",
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0f0f0e",
    marginBottom: 10,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: "#6a6760",
    textAlign: "center",
    marginBottom: 24,
  },
  button: {
    backgroundColor: "#b84a2c",
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 10,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "500",
  },
});
