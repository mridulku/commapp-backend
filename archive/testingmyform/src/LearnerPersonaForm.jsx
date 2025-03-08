// src/LearnerPersonaForm.jsx
import React, { useState, useRef } from "react";
import AcademicForm from "./AcademicForm";

function LearnerPersonaForm() {
  const [step, setStep] = useState(1);
  const subStep = step - 1;

  const [formData, setFormData] = useState({
    academic: {
      educationLevel: "",
      country: "",
      schoolClass: "",
      collegeName: "",
      department: "",
      dailyHours: "",
      preparationGoal: "",
      courseList: [
        {
          id: "123-uuid",
          courseName: "",
          pdfLink: "",
          examDates: [{ type: "", date: "" }],
        },
      ],
      additionalNote: "",
    },
  });

  const academicFormRef = useRef(null);

  const handleInputChange = (e, path) => {
    const [mainKey, subKey] = path.split(".");
    setFormData((prev) => ({
      ...prev,
      [mainKey]: {
        ...prev[mainKey],
        [subKey]: e.target.value,
      },
    }));
  };

  const handleCourseChange = (e, courseIdx, field) => {
    const newValue = e.target.value;
    setFormData((prev) => {
      const updatedCourses = [...prev.academic.courseList];
      updatedCourses[courseIdx] = {
        ...updatedCourses[courseIdx],
        [field]: newValue,
      };
      return {
        ...prev,
        academic: {
          ...prev.academic,
          courseList: updatedCourses,
        },
      };
    });
  };

  const storePdfLinkInState = (courseIdx, url) => {
    setFormData((prev) => {
      const updatedCourses = [...prev.academic.courseList];
      updatedCourses[courseIdx] = {
        ...updatedCourses[courseIdx],
        pdfLink: url,
      };
      return {
        ...prev,
        academic: {
          ...prev.academic,
          courseList: updatedCourses,
        },
      };
    });
  };

  const addExamDate = (courseIdx) => {
    setFormData((prev) => {
      const updatedCourses = [...prev.academic.courseList];
      updatedCourses[courseIdx] = {
        ...updatedCourses[courseIdx],
        examDates: [
          ...updatedCourses[courseIdx].examDates,
          { type: "", date: "" },
        ],
      };
      return {
        ...prev,
        academic: {
          ...prev.academic,
          courseList: updatedCourses,
        },
      };
    });
  };

  const handleExamFieldChange = (e, courseIdx, examIdx, field) => {
    const newValue = e.target.value;
    setFormData((prev) => {
      const updatedCourses = [...prev.academic.courseList];
      const updatedExamDates = [...updatedCourses[courseIdx].examDates];
      updatedExamDates[examIdx] = {
        ...updatedExamDates[examIdx],
        [field]: newValue,
      };
      updatedCourses[courseIdx].examDates = updatedExamDates;
      return {
        ...prev,
        academic: {
          ...prev.academic,
          courseList: updatedCourses,
        },
      };
    });
  };

  const addNewCourse = () => {
    alert("MVP allows only 1 course. Remove this if you want more.");
  };

  // Debug logging each render
  console.log("Rendering LearnerPersonaForm... step =", step, "subStep =", subStep);

  // Basic test nav
  const handleNext = () => setStep((prev) => prev + 1);
  const handleBack = () => setStep((prev) => prev - 1);

  const isLastSubStep = subStep === 4;

  const handleSubmit = async () => {
    console.log("handleSubmit called!");
    if (academicFormRef.current) {
      await academicFormRef.current.uploadAllPDFs();
    }
    alert("Form Submitted. Check console for logs.");
  };

  return (
    <div style={{ border: "1px solid #ccc", padding: 10, marginTop: 20 }}>
      <h2>LearnerPersonaForm (step={step})</h2>

      <AcademicForm
        ref={academicFormRef}
        subStep={subStep}
        formData={formData.academic}
        handleInputChange={handleInputChange}
        handleCourseChange={handleCourseChange}
        addExamDate={addExamDate}
        handleExamFieldChange={handleExamFieldChange}
        addNewCourse={addNewCourse}
        storePdfLinkInState={storePdfLinkInState}
      />

      <div style={{ marginTop: 10 }}>
        <button onClick={handleBack} disabled={step <= 1}>Back</button>
        <button onClick={handleNext}>Next</button>
        <button onClick={handleSubmit}>Submit</button>
      </div>
    </div>
  );
}

export default LearnerPersonaForm;