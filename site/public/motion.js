(() => {
  if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("motion-enter");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.2 });

  document.querySelectorAll("[data-motion]").forEach((element) => observer.observe(element));
})();
