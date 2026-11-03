<script setup>
import { ref } from "vue";

// biome-ignore lint/correctness/noUnusedVariables: the template reads it
const count = ref(0);
</script>

<template>
  <main class="counter">
    <h1>Vue app fixture</h1>
    <button type="button" @click="count++">Clicked {{ count }} times</button>
  </main>
</template>

<style scoped>
.counter {
  font-family: sans-serif;
}
</style>
