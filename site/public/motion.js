(() => {
  if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Con línea de tiempo de scroll la hoja se asienta desde CSS (styles.css, @supports); aquí queda solo el respaldo.
  if (window.CSS && window.CSS.supports("animation-timeline: view()")) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("motion-enter");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.2 });

  document.querySelectorAll("[data-motion]").forEach((element) => observer.observe(element));
})();
